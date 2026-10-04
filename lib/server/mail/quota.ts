import { randomUUID } from "node:crypto";
import type { MailDeliveryStatus, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow, sellerPlanOf } from "../billing/subscription";
import { captureDebit, messageSettings, releaseDebit, reserveDebit } from "../messaging/balance";

// 메일 제공량·충전 잔액 차감(대표님 결정 2026-10-05, docs/terms/SELLER_MESSAGE_FEE_NOTICE.md 1~3절).
// - 거래 메일: 구독 플랜의 월 제공량(SubscriptionPlan.mailMonthlyQuota, KST 달, 다음 달로 넘어가지 않음)까지 무료. 넘으면 발송 충전 잔액에서
//   MAIL_TRANSACTIONAL 단가만큼 차감하고, 잔액이 모자라면 공급자를 부르지 않고 SKIPPED_BALANCE(잔액 부족 미발송)로 남긴다(주문 처리는 계속).
//   충전 기능이 꺼져 있으면(기본) 제공량을 넘는 메일은 차감 없이 SKIPPED_BALANCE로 남긴다.
// - 광고·공지 대량 메일(bulk): 제공량과 상관없이 MAIL_BULK 단가로 차감.
// - 차감은 보내기 전에 잡고(messaging/balance.ts reserveDebit) 성공하면 확정, 실패하면 되돌린다. 차감 키는 발송 기록 id.
// - 플랫폼 전체 무료 한도(메일 서비스 하루·월, PlatformMessageSetting): 다 쓰면 누구의 메일도 보내지 않고(차감도 안 함)
//   SKIPPED_PLATFORM_LIMIT로 남긴다. 80%에 이르면·다 쓰면 기간마다 한 번 로그 추적(mail.platform_near_limit·mail.platform_limit_reached).
// - 셈: 보내는 중(PENDING)과 보낸(SENT) 통을 센다(실패하면 빠짐). 「보낸 수」는 SENT만이다.
//   예약은 플랫폼 메일 잠금(advisory mail_quota) → 잔액 행 순서로 잡고 세고 기록해 동시에 보내도 제공량·잔액·플랫폼 한도를 넘지 않는다.
// - 보내는 쪽(MailSender)은 발송 기록 id를 공급자 멱등키로 보내야 한다(응답 전에 끊겨 다시 보내도 한 통).

type Db = PrismaClient | Prisma.TransactionClient;
const KST_MS = 9 * 3600_000;
const NEAR_RATIO = 0.8;
const COUNTED: MailDeliveryStatus[] = ["PENDING", "SENT"];

export const MAIL_QUOTA_MAX = 10_000_000;

export function kstMonth(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 7);
}

function kstDayStart(d: Date): Date {
  const day = new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00+09:00`);
}

// 적용 예정일이 지난 새 제공량이 있으면 그 값
export const effectiveMailQuota = (p: { mailMonthlyQuota: number; nextMailQuota: number | null; nextMailQuotaAt: Date | null }, now: Date) =>
  p.nextMailQuota !== null && p.nextMailQuotaAt && p.nextMailQuotaAt <= now ? p.nextMailQuota : p.mailMonthlyQuota;

// 파트너스의 월 제공량: 구독 행이 있으면 그 플랜, 없으면 판매자 플랜(체험 한도와 같은 기준, billing/trialLimits.ts)
async function monthlyQuota(db: Db, sellerId: string, now: Date): Promise<number> {
  const sub = await db.sellerSubscription.findUnique({ where: { sellerId }, select: { plan: true } });
  const plan = sub?.plan ?? (await sellerPlanOf(db, sellerId));
  return plan ? effectiveMailQuota(plan, now) : 0;
}

async function platformUsage(db: Db, now: Date) {
  const [day, month] = await Promise.all([
    db.mailDelivery.count({ where: { status: { in: COUNTED }, createdAt: { gte: kstDayStart(now) } } }),
    db.mailDelivery.count({ where: { status: { in: COUNTED }, month: kstMonth(now) } }),
  ]);
  return { day, month };
}

// 플랫폼 한도 로그 추적: 기간(하루·달)마다 한 번만(같은 잠금 아래라 중복 없음)
async function auditPlatformOnce(tx: Prisma.TransactionClient, action: string, period: string, after: Record<string, unknown>) {
  if (await tx.auditLog.findFirst({ where: { action, targetType: "MailPlatform", targetId: period }, select: { id: true } })) return;
  await writeAudit(tx, { actorType: "SYSTEM", actorId: null, action, targetType: "MailPlatform", targetId: period, after });
}

export type MailReservation =
  | { ok: true; deliveryId: string; charged: boolean; ledgerId: string | null }
  | { ok: false; deliveryId: string; reason: "insufficient_balance" | "platform_limit" };

// 한 통 보내기 전에 한도·잔액을 보고 발송 기록을 남긴다. 보낼 수 있으면 PENDING(보낸 뒤 markMailSent·Failed), 아니면 SKIPPED_*.
// sellerId가 null이면 플랫폼 메일(제공량·잔액과 상관없음).
export async function reserveMail(
  db: PrismaClient,
  input: { sellerId: string | null; kind: string; bulk?: boolean; refId?: string | null; now?: Date },
): Promise<MailReservation> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mail_quota'))`;
    const now = input.now ?? (await dbNow(tx));
    const month = kstMonth(now);
    const settings = await messageSettings(tx);
    const id = randomUUID();
    const bulk = !!input.bulk && !!input.sellerId;
    const base = { id, sellerId: input.sellerId, kind: input.kind.slice(0, 50), bulk, refId: input.refId?.slice(0, 100) ?? null, month, createdAt: now };
    const skip = async (status: MailDeliveryStatus, charged: boolean) => {
      await tx.mailDelivery.create({ data: { ...base, status, charged, finishedAt: now } });
      return id;
    };

    const used = await platformUsage(tx, now);
    const day = `day:${new Date(now.getTime() + KST_MS).toISOString().slice(0, 10)}`;
    if (used.day >= settings.platformDailyLimit || used.month >= settings.platformMonthlyLimit) {
      const scope =
        used.day >= settings.platformDailyLimit
          ? { period: day, used: used.day, limit: settings.platformDailyLimit }
          : { period: `month:${month}`, used: used.month, limit: settings.platformMonthlyLimit };
      await auditPlatformOnce(tx, "mail.platform_limit_reached", scope.period, { used: scope.used, limit: scope.limit });
      return { ok: false as const, reason: "platform_limit" as const, deliveryId: await skip("SKIPPED_PLATFORM_LIMIT", false) };
    }

    let ledgerId: string | null = null;
    if (input.sellerId) {
      const sellerId = input.sellerId;
      const free = !bulk && (await tx.mailDelivery.count({ where: { sellerId, month, status: { in: COUNTED }, charged: false, bulk: false } })) < (await monthlyQuota(tx, sellerId, now));
      if (!free) {
        const debit = await reserveDebit(tx, { sellerId, channel: bulk ? "MAIL_BULK" : "MAIL_TRANSACTIONAL", idempotencyKey: `mail:${id}`, now });
        if (!debit.ok) return { ok: false as const, reason: "insufficient_balance" as const, deliveryId: await skip("SKIPPED_BALANCE", true) };
        ledgerId = debit.ledgerId;
      }
    }

    await tx.mailDelivery.create({ data: { ...base, status: "PENDING", charged: ledgerId !== null, ledgerId } });
    // 이번 한 통까지 넣어 80%에 이르면 한 번 남긴다
    if (used.day + 1 >= settings.platformDailyLimit * NEAR_RATIO) {
      await auditPlatformOnce(tx, "mail.platform_near_limit", day, { used: used.day + 1, limit: settings.platformDailyLimit });
    }
    if (used.month + 1 >= settings.platformMonthlyLimit * NEAR_RATIO) {
      await auditPlatformOnce(tx, "mail.platform_near_limit", `month:${month}`, { used: used.month + 1, limit: settings.platformMonthlyLimit });
    }
    return { ok: true as const, deliveryId: id, charged: ledgerId !== null, ledgerId };
  });
}

// 보낸 결과. 보내는 중(PENDING)인 기록만 바꾼다(두 번 불러도 처음 결과 그대로). 차감은 성공이면 확정, 실패면 되돌린다.
export async function markMailSent(db: PrismaClient, deliveryId: string, providerMessageId?: string | null) {
  const now = await dbNow(db);
  const moved = (await db.mailDelivery.updateMany({ where: { id: deliveryId, status: "PENDING" }, data: { status: "SENT", providerMessageId: providerMessageId?.slice(0, 200) ?? null, finishedAt: now } })).count === 1;
  const d = await db.mailDelivery.findUnique({ where: { id: deliveryId }, select: { ledgerId: true, status: true } });
  if (d?.status === "SENT" && d.ledgerId) await captureDebit(db, d.ledgerId);
  return moved;
}

export async function markMailFailed(db: PrismaClient, deliveryId: string) {
  const now = await dbNow(db);
  const moved = (await db.mailDelivery.updateMany({ where: { id: deliveryId, status: "PENDING" }, data: { status: "FAILED", finishedAt: now } })).count === 1;
  const d = await db.mailDelivery.findUnique({ where: { id: deliveryId }, select: { ledgerId: true, status: true } });
  if (d?.status === "FAILED" && d.ledgerId) await releaseDebit(db, d.ledgerId);
  return moved;
}

export type MailMessage = { to: string; subject: string; html: string; text?: string };
// 메일 공급자 연결. idempotencyKey(발송 기록 id)를 공급자 멱등키로 보낸다. 실패하면 던진다.
export type MailSender = { send(message: MailMessage, opts: { idempotencyKey: string }): Promise<{ providerMessageId?: string | null }> };

// 한도를 보고 보낸다. 결과 상태를 돌려주고 던지지 않는다(메일이 막히거나 실패해도 부른 쪽 처리는 계속).
export async function sendMail(
  db: PrismaClient,
  sender: MailSender,
  input: { sellerId: string | null; kind: string; bulk?: boolean; refId?: string | null; message: MailMessage },
): Promise<{ deliveryId: string; status: MailDeliveryStatus; charged: boolean }> {
  const r = await reserveMail(db, input);
  if (!r.ok) return { deliveryId: r.deliveryId, status: r.reason === "platform_limit" ? "SKIPPED_PLATFORM_LIMIT" : "SKIPPED_BALANCE", charged: r.reason === "insufficient_balance" };
  try {
    const sent = await sender.send(input.message, { idempotencyKey: r.deliveryId });
    await markMailSent(db, r.deliveryId, sent.providerMessageId);
    return { deliveryId: r.deliveryId, status: "SENT", charged: r.charged };
  } catch (e) {
    console.error("[mail.send_failed]", r.deliveryId, e instanceof Error ? e.message : e);
    await markMailFailed(db, r.deliveryId);
    return { deliveryId: r.deliveryId, status: "FAILED", charged: r.charged };
  }
}

// 파트너스의 이번 달(KST) 메일 사용 현황
export async function sellerMailUsage(db: Db, sellerId: string, now?: Date) {
  const at = now ?? (await dbNow(db));
  const month = kstMonth(at);
  const [quota, rows] = await Promise.all([
    monthlyQuota(db, sellerId, at),
    db.mailDelivery.groupBy({ by: ["status", "charged"], where: { sellerId, month }, _count: { _all: true } }),
  ]);
  const n = (status: MailDeliveryStatus, charged?: boolean) =>
    rows.filter((r) => r.status === status && (charged === undefined || r.charged === charged)).reduce((a, r) => a + r._count._all, 0);
  return {
    month,
    quota,
    sent: n("SENT"),
    freeSent: n("SENT", false),
    chargedSent: n("SENT", true),
    pending: n("PENDING"),
    skippedBalance: n("SKIPPED_BALANCE"),
    skippedPlatformLimit: n("SKIPPED_PLATFORM_LIMIT"),
    failed: n("FAILED"),
  };
}

// 플랫폼 전체 사용 현황(마스터 관리자)
export async function platformMailUsage(db: Db, now?: Date) {
  const at = now ?? (await dbNow(db));
  const [settings, used, skipped] = await Promise.all([
    messageSettings(db),
    platformUsage(db, at),
    db.mailDelivery.count({ where: { status: "SKIPPED_PLATFORM_LIMIT", month: kstMonth(at) } }),
  ]);
  return {
    month: kstMonth(at),
    today: { used: used.day, limit: settings.platformDailyLimit },
    thisMonth: { used: used.month, limit: settings.platformMonthlyLimit },
    skippedPlatformLimit: skipped,
  };
}
