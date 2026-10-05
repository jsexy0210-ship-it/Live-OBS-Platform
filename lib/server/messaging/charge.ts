import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import type { BillingProvider, ChargeResult } from "../billing/provider";
import { openBillingKey } from "../billing/secret";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { MESSAGE_FEE_NOTICE_VERSION, balanceOf, lockBalance, messageSettings } from "./balance";

// 발송 충전(서식 2·7절). 대표자가 구독 결제 카드(빌링키)로 유료 잔액을 충전한다. 결제 공급자는 구독과 같은 것(지금은 가짜 공급자만,
// 실제 결제 없음). 충전 기능 스위치가 켜져 있고 지금 서식 버전에 동의했을 때만 한다.
// 흐름: 충전 기록(PENDING)을 먼저 커밋 → 공급자 결제(주문 번호 = 충전 id, 같은 번호는 한 번만 결제) → 결과 확정(settleMessageCharge).
// 결제 응답이 끊기면 PENDING으로 두고 reconcileMessageCharges가 공급자 조회로 확정한다. 확정 때 충전 기록을 잠그고 PENDING일 때만
// 잔액을 늘리므로 두 번 확정해도 한 번만 늘어난다(원장 키 charge:{id}도 부분 유니크로 막음).
export const CHARGE_MIN = 1_000;
export const CHARGE_MAX = 1_000_000;
export const CHARGE_UNIT = 1_000;
const RECONCILE_AFTER_MS = 60_000;
const GIVE_UP_NOT_FOUND_MS = 10 * 60_000;

type ChargeView = { id: string; amount: number; status: "PENDING" | "PAID" | "FAILED"; failureReason: string | null; receiptUrl: string | null; createdAt: Date; finishedAt: Date | null };
const VIEW = { id: true, amount: true, status: true, failureReason: true, receiptUrl: true, createdAt: true, finishedAt: true } as const;

export type ChargeFailure = "invalid_charge" | "charging_disabled" | "consent_required" | "card_required";

export async function chargeMessageBalance(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { amount?: unknown; idempotencyKey?: unknown },
): Promise<{ ok: true; charge: ChargeView } | { ok: false; reason: ChargeFailure }> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  if (ctx.actorType !== "SELLER_USER" || !ctx.actorId) throw forbidden();
  const amount = input.amount;
  const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < CHARGE_MIN || amount > CHARGE_MAX || amount % CHARGE_UNIT !== 0 || !key || key.length > 100) {
    return { ok: false, reason: "invalid_charge" };
  }
  // 같은 요청을 다시 보내면 결제하지 않고 그 충전의 지금 상태(응답이 끊겼던 PENDING은 공급자 조회로 확정해 본다)
  const prev = await db.messageCharge.findUnique({ where: { sellerId_idempotencyKey: { sellerId: ctx.sellerId, idempotencyKey: key } }, select: VIEW });
  if (prev) return { ok: true, charge: prev.status === "PENDING" ? await resolvePending(db, provider, prev.id) : prev };
  if (!(await messageSettings(db)).chargingEnabled) return { ok: false, reason: "charging_disabled" };
  const consent = await db.sellerMessageFeeConsent.findUnique({ where: { sellerId_version: { sellerId: ctx.sellerId, version: MESSAGE_FEE_NOTICE_VERSION } }, select: { id: true } });
  if (!consent) return { ok: false, reason: "consent_required" };
  const sub = await db.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, select: { billingKeyCipher: true } });
  if (!sub?.billingKeyCipher) return { ok: false, reason: "card_required" };

  let charge: ChargeView;
  try {
    charge = await db.$transaction(async (tx) => {
      const c = await tx.messageCharge.create({
        data: { sellerId: ctx.sellerId, sellerUserId: ctx.actorId!, amount, idempotencyKey: key, noticeVersion: MESSAGE_FEE_NOTICE_VERSION },
        select: VIEW,
      });
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "seller.message_charge.request", targetType: "MessageCharge", targetId: c.id, after: { amount } });
      return c;
    });
  } catch (e) {
    // 같은 키 동시 요청: 먼저 만든 쪽의 충전을 돌려준다
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await db.messageCharge.findUniqueOrThrow({ where: { sellerId_idempotencyKey: { sellerId: ctx.sellerId, idempotencyKey: key } }, select: VIEW });
      return { ok: true, charge: existing };
    }
    throw e;
  }
  let result: ChargeResult;
  try {
    result = await provider.charge({ billingKey: openBillingKey(sub.billingKeyCipher, ctx.sellerId), customerKey: ctx.sellerId, amount, orderId: charge.id, orderName: "발송 충전" });
  } catch (e) {
    // 결제됐는지 모른다. PENDING으로 두고 대조에서 확정한다(다시 결제하지 않음).
    console.error("[message_charge.unresolved]", charge.id, e instanceof Error ? e.message : e);
    return { ok: true, charge };
  }
  return { ok: true, charge: await settleMessageCharge(db, charge.id, result) };
}

// 결제 결과 확정. PENDING인 충전만 바꾼다. 성공이면 같은 트랜잭션에서 유료 잔액 + 원장 CHARGE.
export async function settleMessageCharge(db: PrismaClient, chargeId: string, result: ChargeResult): Promise<ChargeView> {
  return db.$transaction(async (tx) => {
    const [c] = await tx.$queryRaw<{ sellerId: string; amount: number; status: string; sellerUserId: string }[]>`
      SELECT "sellerId", "amount", "status"::text AS "status", "sellerUserId" FROM "MessageCharge" WHERE "id" = ${chargeId}::uuid FOR UPDATE`;
    if (!c) throw new Error("charge_not_found");
    if (c.status === "PENDING") {
      const now = await dbNow(tx);
      if (result.ok) {
        await tx.messageCharge.update({ where: { id: chargeId }, data: { status: "PAID", providerPaymentId: result.paymentId, receiptUrl: result.receiptUrl, finishedAt: now } });
        await lockBalance(tx, c.sellerId);
        await tx.sellerMessageBalance.update({ where: { sellerId: c.sellerId }, data: { paidBalance: { increment: c.amount } } });
        await tx.sellerMessageLedger.create({
          data: {
            sellerId: c.sellerId,
            type: "CHARGE",
            status: "SUCCEEDED",
            paidAmount: c.amount,
            freeAmount: 0,
            idempotencyKey: `charge:${chargeId}`,
            actorType: "SELLER_USER",
            actorId: c.sellerUserId,
            createdAt: now,
            finishedAt: now,
          },
        });
        await writeAudit(tx, { actorType: "SYSTEM", sellerId: c.sellerId, action: "seller.message_charge.paid", targetType: "MessageCharge", targetId: chargeId, after: { amount: c.amount } });
      } else {
        await tx.messageCharge.update({ where: { id: chargeId }, data: { status: "FAILED", failureReason: result.reason.slice(0, 100), finishedAt: now } });
        await writeAudit(tx, { actorType: "SYSTEM", sellerId: c.sellerId, action: "seller.message_charge.failed", targetType: "MessageCharge", targetId: chargeId, reason: result.reason.slice(0, 100) });
      }
    }
    return tx.messageCharge.findUniqueOrThrow({ where: { id: chargeId }, select: VIEW });
  });
}

// PENDING 한 건을 공급자 조회로 확정해 본다. 공급자에 기록이 없고 오래됐으면(10분) 결제 안 됨으로 닫는다.
async function resolvePending(db: PrismaClient, provider: BillingProvider, chargeId: string, now?: Date): Promise<ChargeView> {
  const found = await provider.getPayment(chargeId);
  if (found.status === "PAID") return settleMessageCharge(db, chargeId, { ok: true, paymentId: found.paymentId, receiptUrl: found.receiptUrl });
  if (found.status === "FAILED") return settleMessageCharge(db, chargeId, { ok: false, reason: found.reason });
  const c = await db.messageCharge.findUniqueOrThrow({ where: { id: chargeId }, select: VIEW });
  const at = now ?? (await dbNow(db));
  if (c.status === "PENDING" && c.createdAt.getTime() + GIVE_UP_NOT_FOUND_MS <= at.getTime()) return settleMessageCharge(db, chargeId, { ok: false, reason: "not_charged" });
  return c;
}

// 응답이 끊긴 충전 대조(messaging/jobs.ts 정기 작업). 1분 넘게 PENDING인 충전을 오래된 순으로 limit건.
// deadline(실제 시계 ms)을 넘기면 다음 건을 시작하지 않고 멈춘다(truncated). 남은 건은 다음 실행이 오래된 순으로 이어서 처리한다.
export async function reconcileMessageCharges(db: PrismaClient, provider: BillingProvider, opts: { now?: Date; limit?: number; deadline?: number } = {}) {
  const now = opts.now ?? (await dbNow(db));
  const rows = await db.messageCharge.findMany({
    where: { status: "PENDING", createdAt: { lte: new Date(now.getTime() - RECONCILE_AFTER_MS) } },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
    select: { id: true },
  });
  const summary = { paid: 0, failed: 0, pending: 0, errors: 0, truncated: false };
  for (const r of rows) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      summary.truncated = true;
      break;
    }
    try {
      const c = await resolvePending(db, provider, r.id, now);
      summary[c.status === "PAID" ? "paid" : c.status === "FAILED" ? "failed" : "pending"]++;
    } catch (e) {
      summary.errors++;
      console.error("[message_charge.reconcile]", r.id, e);
    }
  }
  return summary;
}

// 충전 내역(대표자). 최근 20건.
export async function listMessageCharges(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const [charges, balance] = await Promise.all([
    db.messageCharge.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: VIEW }),
    balanceOf(db, ctx.sellerId),
  ]);
  return { charges, balance };
}
