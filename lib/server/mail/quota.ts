import type { MailDeliveryStatus, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow, sellerPlanOf } from "../billing/subscription";

// 메일 제공량·초과 발송(대표님 결정 2026-10-05, CLAUDE.md 「유료 서비스」).
// - 파트너스 메일: 구독 플랜의 월 제공량(SubscriptionPlan.mailMonthlyQuota, KST 달)까지 보낸다. 넘으면 파트너스가 「초과 발송 허용」을
//   켜고 이번 달 초과 상한(SellerMailPolicy.overageMonthlyCap) 안일 때만 초과분(overage)으로 보내고, 아니면 보내지 않고
//   SKIPPED_QUOTA로 남긴다(주문 처리는 계속). 초과분은 다음 달 구독 청구에 합산한다(청구 합산은 후속, 통당 단가 PlatformMailSetting).
// - 플랫폼 전체 무료 한도(메일 서비스 하루·월, PlatformMailSetting): 다 쓰면 누구의 메일도 보내지 않고 SKIPPED_PLATFORM_LIMIT로 남긴다.
//   80%에 이르면·다 쓰면 기간마다 한 번 로그 추적(mail.platform_near_limit·mail.platform_limit_reached)을 남긴다.
// - 셈: 보내는 중(PENDING)과 보낸(SENT) 통을 센다(실패하면 빠짐). 「이번 달 보낸 수」는 SENT만이다.
//   예약은 플랫폼 메일 잠금(advisory) 하나 아래에서 세고 기록해 동시에 보내도 제공량·상한·플랫폼 한도를 넘지 않는다.
// - 보내는 쪽(MailSender)은 발송 기록 id를 공급자 멱등키로 보내야 한다(응답 전에 끊겨 다시 보내도 한 통).

type Db = PrismaClient | Prisma.TransactionClient;
const KST_MS = 9 * 3600_000;
const NEAR_RATIO = 0.8;
const COUNTED: MailDeliveryStatus[] = ["PENDING", "SENT"];

export const MAIL_CAP_MAX = 100_000;
export const MAIL_QUOTA_MAX = 10_000_000;
export const MAIL_UNIT_PRICE_MAX = 100_000;

export function kstMonth(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 7);
}

function kstDayStart(d: Date): Date {
  const day = new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00+09:00`);
}

export async function mailSettings(db: Db) {
  return (await db.platformMailSetting.findUnique({ where: { id: 1 } })) ?? { id: 1, overageUnitPrice: 0, platformDailyLimit: 100, platformMonthlyLimit: 3000, updatedAt: null };
}

export async function sellerMailPolicy(db: Db, sellerId: string) {
  const p = await db.sellerMailPolicy.findUnique({ where: { sellerId } });
  return { overageAllowed: p?.overageAllowed ?? false, overageMonthlyCap: p?.overageMonthlyCap ?? 0 };
}

// 파트너스의 월 제공량: 구독 행이 있으면 그 플랜, 없으면 판매자 플랜(체험 한도와 같은 기준, billing/trialLimits.ts)
async function monthlyQuota(db: Db, sellerId: string): Promise<number> {
  const sub = await db.sellerSubscription.findUnique({ where: { sellerId }, select: { plan: { select: { mailMonthlyQuota: true } } } });
  return sub?.plan.mailMonthlyQuota ?? (await sellerPlanOf(db, sellerId))?.mailMonthlyQuota ?? 0;
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
  | { ok: true; deliveryId: string; overage: boolean }
  | { ok: false; deliveryId: string; reason: "quota_exceeded" | "platform_limit" };

// 한 통 보내기 전에 한도를 보고 발송 기록을 남긴다. 보낼 수 있으면 PENDING(보낸 뒤 markMailSent·Failed), 아니면 SKIPPED_*.
// sellerId가 null이면 플랫폼 메일(파트너스 제공량에 세지 않음).
export async function reserveMail(db: PrismaClient, input: { sellerId: string | null; kind: string; refId?: string | null; now?: Date }): Promise<MailReservation> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mail_quota'))`;
    const now = input.now ?? (await dbNow(tx));
    const month = kstMonth(now);
    const settings = await mailSettings(tx);
    const base = { sellerId: input.sellerId, kind: input.kind.slice(0, 50), refId: input.refId?.slice(0, 100) ?? null, month, createdAt: now };
    const skip = async (status: MailDeliveryStatus, overage: boolean) =>
      (await tx.mailDelivery.create({ data: { ...base, status, overage, finishedAt: now }, select: { id: true } })).id;

    const used = await platformUsage(tx, now);
    const day = `day:${new Date(now.getTime() + KST_MS).toISOString().slice(0, 10)}`;
    if (used.day >= settings.platformDailyLimit || used.month >= settings.platformMonthlyLimit) {
      const scope = used.day >= settings.platformDailyLimit ? { period: day, used: used.day, limit: settings.platformDailyLimit } : { period: `month:${month}`, used: used.month, limit: settings.platformMonthlyLimit };
      await auditPlatformOnce(tx, "mail.platform_limit_reached", scope.period, { used: scope.used, limit: scope.limit });
      return { ok: false as const, reason: "platform_limit" as const, deliveryId: await skip("SKIPPED_PLATFORM_LIMIT", false) };
    }

    let overage = false;
    if (input.sellerId) {
      const sellerId = input.sellerId;
      const [quota, policy, normal] = await Promise.all([
        monthlyQuota(tx, sellerId),
        sellerMailPolicy(tx, sellerId),
        tx.mailDelivery.count({ where: { sellerId, month, status: { in: COUNTED }, overage: false } }),
      ]);
      if (normal >= quota) {
        const over = await tx.mailDelivery.count({ where: { sellerId, month, status: { in: COUNTED }, overage: true } });
        if (!policy.overageAllowed || over >= policy.overageMonthlyCap) {
          return { ok: false as const, reason: "quota_exceeded" as const, deliveryId: await skip("SKIPPED_QUOTA", true) };
        }
        overage = true;
      }
    }

    const row = await tx.mailDelivery.create({ data: { ...base, status: "PENDING", overage }, select: { id: true } });
    // 이번 한 통까지 넣어 80%에 이르면 한 번 남긴다
    if (used.day + 1 >= settings.platformDailyLimit * NEAR_RATIO) {
      await auditPlatformOnce(tx, "mail.platform_near_limit", day, { used: used.day + 1, limit: settings.platformDailyLimit });
    }
    if (used.month + 1 >= settings.platformMonthlyLimit * NEAR_RATIO) {
      await auditPlatformOnce(tx, "mail.platform_near_limit", `month:${month}`, { used: used.month + 1, limit: settings.platformMonthlyLimit });
    }
    return { ok: true as const, deliveryId: row.id, overage };
  });
}

// 보낸 결과. 보내는 중(PENDING)인 기록만 바꾼다(두 번 불러도 처음 결과 그대로).
export async function markMailSent(db: Db, deliveryId: string, providerMessageId?: string | null) {
  const now = await dbNow(db);
  return (await db.mailDelivery.updateMany({ where: { id: deliveryId, status: "PENDING" }, data: { status: "SENT", providerMessageId: providerMessageId?.slice(0, 200) ?? null, finishedAt: now } })).count === 1;
}

export async function markMailFailed(db: Db, deliveryId: string) {
  const now = await dbNow(db);
  return (await db.mailDelivery.updateMany({ where: { id: deliveryId, status: "PENDING" }, data: { status: "FAILED", finishedAt: now } })).count === 1;
}

export type MailMessage = { to: string; subject: string; html: string; text?: string };
// 메일 공급자 연결. idempotencyKey(발송 기록 id)를 공급자 멱등키로 보낸다. 실패하면 던진다.
export type MailSender = { send(message: MailMessage, opts: { idempotencyKey: string }): Promise<{ providerMessageId?: string | null }> };

// 한도를 보고 보낸다. 결과 상태를 돌려주고 던지지 않는다(메일이 막히거나 실패해도 부른 쪽 처리는 계속).
export async function sendMail(
  db: PrismaClient,
  sender: MailSender,
  input: { sellerId: string | null; kind: string; refId?: string | null; message: MailMessage },
): Promise<{ deliveryId: string; status: MailDeliveryStatus; overage: boolean }> {
  const r = await reserveMail(db, input);
  if (!r.ok) return { deliveryId: r.deliveryId, status: r.reason === "platform_limit" ? "SKIPPED_PLATFORM_LIMIT" : "SKIPPED_QUOTA", overage: r.reason === "quota_exceeded" };
  try {
    const sent = await sender.send(input.message, { idempotencyKey: r.deliveryId });
    await markMailSent(db, r.deliveryId, sent.providerMessageId);
    return { deliveryId: r.deliveryId, status: "SENT", overage: r.overage };
  } catch (e) {
    console.error("[mail.send_failed]", r.deliveryId, e instanceof Error ? e.message : e);
    await markMailFailed(db, r.deliveryId);
    return { deliveryId: r.deliveryId, status: "FAILED", overage: r.overage };
  }
}

// 파트너스의 이번 달(KST) 메일 사용 현황
export async function sellerMailUsage(db: Db, sellerId: string, now?: Date) {
  const at = now ?? (await dbNow(db));
  const month = kstMonth(at);
  const [quota, policy, settings, rows] = await Promise.all([
    monthlyQuota(db, sellerId),
    sellerMailPolicy(db, sellerId),
    mailSettings(db),
    db.mailDelivery.groupBy({ by: ["status", "overage"], where: { sellerId, month }, _count: { _all: true } }),
  ]);
  const n = (status: MailDeliveryStatus, overage?: boolean) =>
    rows.filter((r) => r.status === status && (overage === undefined || r.overage === overage)).reduce((a, r) => a + r._count._all, 0);
  const overageSent = n("SENT", true);
  return {
    month,
    quota,
    sent: n("SENT"),
    overageSent,
    pending: n("PENDING"),
    skippedQuota: n("SKIPPED_QUOTA"),
    skippedPlatformLimit: n("SKIPPED_PLATFORM_LIMIT"),
    failed: n("FAILED"),
    ...policy,
    overageUnitPrice: settings.overageUnitPrice,
    overageAmount: overageSent * settings.overageUnitPrice,
  };
}

// 플랫폼 전체 사용 현황(마스터 관리자)
export async function platformMailUsage(db: Db, now?: Date) {
  const at = now ?? (await dbNow(db));
  const [settings, used, skipped] = await Promise.all([
    mailSettings(db),
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
