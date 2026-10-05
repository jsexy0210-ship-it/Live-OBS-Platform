import { Prisma, type ActorType, type MessageChannel, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";

// 발송 충전 잔액(대표님 결정 2026-10-05, docs/terms/SELLER_MESSAGE_FEE_NOTICE.md).
// - 유료(직접 충전)·무상(이벤트·보상) 잔액을 나눠 두고 둘 다 음수가 될 수 없다(DB CHECK). 차감은 유료 먼저, 모자라면 무상(서식 4-2).
// - 차감은 보내기 전에 잡아 두고(reserveDebit, PENDING) 성공하면 확정(captureDebit), 실패하면 되돌린다(releaseDebit, 서식 3-1).
//   잔액이 모자라면 잡지 않고 insufficient_balance(부른 쪽이 「잔액 부족 미발송」을 남기고 주문 처리는 계속, 서식 2-2).
// - 같은 요청 키(idempotencyKey)는 되돌린 것을 빼고 한 번만 차감한다(서식 3-3). 알림톡이 실패해 문자로 대신 보내면 알림톡 차감을
//   되돌린 뒤 같은 키로 문자를 잡아, 최종 성공 채널 한 건만 남는다(서식 3-2).
// - 잔액 행을 FOR UPDATE로 잡고 판단·기록하므로 동시에 차감해도 잔액을 넘지 않는다. 다른 잠금보다 뒤에 잡는다(메일은 mail_quota 다음).
// - 충전 기능 스위치(PlatformMessageSetting.chargingEnabled, 기본 꺼짐)가 꺼진 동안은 단가와 상관없이 차감하지 않고 charging_disabled
//   (서식 값·법률 검토 전 기능 꺼짐). 메일은 제공량을 넘으면 보내지 않는다.
// - 충전은 messaging/charge.ts(구독 카드 결제, 테스트 모드 공급자만). 환불(REFUND) 실행은 아직 없다(수수료율 서식 값 필요).

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export const MESSAGE_FEE_NOTICE_VERSION = "2026-10-05";
export const MESSAGE_CHANNELS: readonly MessageChannel[] = ["MAIL_TRANSACTIONAL", "MAIL_BULK", "SMS", "LMS", "ALIMTALK", "IDENTITY_VERIFICATION", "DELIVERY_TRACKING"];
export const MESSAGE_AMOUNT_MAX = 10_000_000;
export const MESSAGE_UNIT_PRICE_MAX = 100_000;

export async function messageSettings(db: Db) {
  return (await db.platformMessageSetting.findUnique({ where: { id: 1 } })) ?? { id: 1, chargingEnabled: false, platformDailyLimit: 100, platformMonthlyLimit: 3000, updatedAt: null };
}

// 적용 예정일이 지난 새 단가가 있으면 그 값
const effective = (p: { unitPrice: number; pendingUnitPrice: number | null; pendingEffectiveAt: Date | null } | null, now: Date) =>
  !p ? 0 : p.pendingUnitPrice !== null && p.pendingEffectiveAt && p.pendingEffectiveAt <= now ? p.pendingUnitPrice : p.unitPrice;

export async function channelPrice(db: Db, channel: MessageChannel, now: Date) {
  return effective(await db.messageChannelPrice.findUnique({ where: { channel } }), now);
}

export async function channelPrices(db: Db, now: Date) {
  const rows = await db.messageChannelPrice.findMany();
  return MESSAGE_CHANNELS.map((channel) => {
    const p = rows.find((r) => r.channel === channel) ?? null;
    const due = !!p && p.pendingUnitPrice !== null && !!p.pendingEffectiveAt && p.pendingEffectiveAt <= now;
    return {
      channel,
      unitPrice: effective(p, now),
      next: p && !due && p.pendingUnitPrice !== null && p.pendingEffectiveAt ? { unitPrice: p.pendingUnitPrice, effectiveAt: p.pendingEffectiveAt } : null,
    };
  });
}

// 잔액 행을 만들고(없으면) 잠근다
export async function lockBalance(tx: Tx, sellerId: string) {
  await tx.$executeRaw`INSERT INTO "SellerMessageBalance" ("sellerId", "updatedAt") VALUES (${sellerId}::uuid, now()) ON CONFLICT ("sellerId") DO NOTHING`;
  const [row] = await tx.$queryRaw<{ paidBalance: number; freeBalance: number }[]>`
    SELECT "paidBalance", "freeBalance" FROM "SellerMessageBalance" WHERE "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return row;
}

export type DebitResult =
  | { ok: true; ledgerId: string; amount: number; existing: boolean }
  | { ok: false; reason: "insufficient_balance" | "charging_disabled"; amount: number };

// 차감 잡기(트랜잭션 안에서). 같은 키로 살아 있는 차감이 있으면 새로 잡지 않고 그것을 돌려준다(existing).
export async function reserveDebit(
  tx: Tx,
  input: { sellerId: string; channel: MessageChannel; idempotencyKey: string; quantity?: number; now?: Date; actor?: { actorType: ActorType; actorId: string | null } },
): Promise<DebitResult> {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) throw new Error("invalid_quantity");
  const key = input.idempotencyKey.slice(0, 200);
  const balance = await lockBalance(tx, input.sellerId);
  // 잔액 행 잠금 아래에서 찾으므로 같은 키 동시 요청은 뒤에 온 쪽이 앞의 기록을 본다
  const live = await tx.sellerMessageLedger.findFirst({
    where: { sellerId: input.sellerId, idempotencyKey: key, status: { not: "REVERSED" } },
    select: { id: true, paidAmount: true, freeAmount: true },
  });
  if (live) return { ok: true, ledgerId: live.id, amount: -(live.paidAmount + live.freeAmount), existing: true };
  const now = input.now ?? (await dbNow(tx));
  const unitPrice = await channelPrice(tx, input.channel, now);
  const amount = unitPrice * quantity;
  if (!(await messageSettings(tx)).chargingEnabled) return { ok: false, reason: "charging_disabled", amount };
  if (balance.paidBalance + balance.freeBalance < amount) return { ok: false, reason: "insufficient_balance", amount };
  const paid = Math.min(balance.paidBalance, amount);
  const free = amount - paid;
  if (amount > 0) {
    await tx.sellerMessageBalance.update({ where: { sellerId: input.sellerId }, data: { paidBalance: { decrement: paid }, freeBalance: { decrement: free } } });
  }
  const row = await tx.sellerMessageLedger.create({
    data: {
      sellerId: input.sellerId,
      type: "DEBIT",
      status: "PENDING",
      channel: input.channel,
      quantity,
      unitPrice,
      paidAmount: -paid,
      freeAmount: -free,
      idempotencyKey: key,
      actorType: input.actor?.actorType ?? "SYSTEM",
      actorId: input.actor?.actorId ?? null,
      createdAt: now,
    },
    select: { id: true },
  });
  return { ok: true, ledgerId: row.id, amount, existing: false };
}

// 성공 확정. 잡아 둔(PENDING) 차감만 바꾼다.
export async function captureDebit(db: Db, ledgerId: string) {
  const now = await dbNow(db);
  return (await db.sellerMessageLedger.updateMany({ where: { id: ledgerId, type: "DEBIT", status: "PENDING" }, data: { status: "SUCCEEDED", finishedAt: now } })).count === 1;
}

// 실패 되돌리기: 잔액 행을 잠그고, 잡아 둔(PENDING) 차감만 REVERSED로 바꾼 뒤 그만큼 돌려준다(확정된 차감은 그대로).
export async function releaseDebit(db: PrismaClient, ledgerId: string) {
  return db.$transaction((tx) => releaseDebitTx(tx, ledgerId));
}

export async function releaseDebitTx(tx: Tx, ledgerId: string) {
  const row = await tx.sellerMessageLedger.findUnique({ where: { id: ledgerId }, select: { sellerId: true } });
  if (!row) return false;
  await lockBalance(tx, row.sellerId);
  const now = await dbNow(tx);
  const [moved] = await tx.$queryRaw<{ paidAmount: number; freeAmount: number }[]>`
    UPDATE "SellerMessageLedger" SET "status" = 'REVERSED', "finishedAt" = ${now}
    WHERE "id" = ${ledgerId}::uuid AND "type" = 'DEBIT' AND "status" = 'PENDING'
    RETURNING "paidAmount", "freeAmount"`;
  if (!moved) return false;
  if (moved.paidAmount !== 0 || moved.freeAmount !== 0) {
    await tx.sellerMessageBalance.update({ where: { sellerId: row.sellerId }, data: { paidBalance: { increment: -moved.paidAmount }, freeBalance: { increment: -moved.freeAmount } } });
  }
  return true;
}

// 무상 지급(이벤트·보상, 환불 대상 아님). 최고관리자(부르는 쪽이 권한 확인). 같은 키는 한 번만.
export async function grantFreeBalance(
  db: PrismaClient,
  input: { sellerId: string; amount: number; reason: string; idempotencyKey: string; adminId: string; meta?: { ip?: string | null; userAgent?: string | null } },
) {
  return db.$transaction(async (tx) => {
    await lockBalance(tx, input.sellerId);
    const key = `grant:${input.idempotencyKey.slice(0, 190)}`;
    const live = await tx.sellerMessageLedger.findFirst({ where: { sellerId: input.sellerId, idempotencyKey: key }, select: { id: true, freeAmount: true } });
    if (live) return { ledgerId: live.id, existing: true };
    const now = await dbNow(tx);
    await tx.sellerMessageBalance.update({ where: { sellerId: input.sellerId }, data: { freeBalance: { increment: input.amount } } });
    const row = await tx.sellerMessageLedger.create({
      data: {
        sellerId: input.sellerId,
        type: "GRANT",
        status: "SUCCEEDED",
        paidAmount: 0,
        freeAmount: input.amount,
        idempotencyKey: key,
        reason: input.reason,
        actorType: "PLATFORM_ADMIN",
        actorId: input.adminId,
        createdAt: now,
        finishedAt: now,
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: input.adminId,
      sellerId: input.sellerId,
      action: "admin.message_balance.grant",
      targetType: "SellerMessageLedger",
      targetId: row.id,
      reason: input.reason,
      after: { freeAmount: input.amount },
      ip: input.meta?.ip,
      userAgent: input.meta?.userAgent,
    });
    return { ledgerId: row.id, existing: false };
  });
}

export async function balanceOf(db: Db, sellerId: string) {
  const b = await db.sellerMessageBalance.findUnique({ where: { sellerId } });
  const paidBalance = b?.paidBalance ?? 0;
  const freeBalance = b?.freeBalance ?? 0;
  const lowBalanceThreshold = b?.lowBalanceThreshold ?? 0;
  return { paidBalance, freeBalance, total: paidBalance + freeBalance, lowBalanceThreshold, lowBalance: lowBalanceThreshold > 0 && paidBalance + freeBalance < lowBalanceThreshold };
}
