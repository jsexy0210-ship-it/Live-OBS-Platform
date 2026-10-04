import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { MAIL_CAP_MAX, MAIL_QUOTA_MAX, MAIL_UNIT_PRICE_MAX, mailSettings, platformMailUsage, sellerMailPolicy, sellerMailUsage } from "./quota";

// 메일 제공량·초과 발송 설정(lib/server/mail/quota.ts).
// - 파트너스: 초과 발송 허용·월 초과 상한. 비용이 드는 설정이라 대표자만(SUBSCRIPTION_MANAGE). 로그 추적 seller.mail_policy.update.
// - 마스터 관리자: 플랜별 월 제공량, 통당 단가·플랫폼 무료 한도. 바꾸기는 최고관리자만(billing.price), 보기는 platform.read.
type Meta = { ip?: string | null; userAgent?: string | null };
const isInt = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

export async function getSellerMail(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  return sellerMailUsage(db, ctx.sellerId);
}

// 빼고 보내면 지금 값 유지
export async function updateSellerMailPolicy(db: PrismaClient, ctx: TenantContext, input: { overageAllowed?: unknown; overageMonthlyCap?: unknown }) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  if (input.overageAllowed !== undefined && typeof input.overageAllowed !== "boolean") return { ok: false as const };
  if (input.overageMonthlyCap !== undefined && !isInt(input.overageMonthlyCap, MAIL_CAP_MAX)) return { ok: false as const };
  if (input.overageAllowed === undefined && input.overageMonthlyCap === undefined) return { ok: false as const };
  await db.$transaction(async (tx) => {
    // 같은 파트너스의 동시 변경이 전후 기록을 어긋나게 하지 않도록 판매자 행을 잠근다
    await tx.$queryRaw`SELECT "id" FROM "Seller" WHERE "id" = ${ctx.sellerId}::uuid FOR UPDATE`;
    const before = await sellerMailPolicy(tx, ctx.sellerId);
    const data = {
      overageAllowed: (input.overageAllowed as boolean | undefined) ?? before.overageAllowed,
      overageMonthlyCap: (input.overageMonthlyCap as number | undefined) ?? before.overageMonthlyCap,
    };
    await tx.sellerMailPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.mail_policy.update",
      targetType: "SellerMailPolicy",
      targetId: ctx.sellerId,
      before,
      after: data,
    });
  });
  return { ok: true as const, mail: await sellerMailUsage(db, ctx.sellerId) };
}

// 마스터 관리자: 플랜별 제공량·통당 단가·플랫폼 한도와 이번 달 사용 현황
export async function getAdminMailSettings(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const [settings, plans, usage] = await Promise.all([
    mailSettings(db),
    db.subscriptionPlan.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true, mailMonthlyQuota: true } }),
    platformMailUsage(db),
  ]);
  return {
    overageUnitPrice: settings.overageUnitPrice,
    platformDailyLimit: settings.platformDailyLimit,
    platformMonthlyLimit: settings.platformMonthlyLimit,
    plans,
    usage,
  };
}

// 빼고 보내면 지금 값 유지
export async function updateAdminMailSettings(
  db: PrismaClient,
  admin: AdminSessionContext,
  input: { overageUnitPrice?: unknown; platformDailyLimit?: unknown; platformMonthlyLimit?: unknown },
  meta: Meta = {},
) {
  if (!adminCan(admin.admin.role, "billing.price")) throw forbidden();
  const keys = ["overageUnitPrice", "platformDailyLimit", "platformMonthlyLimit"] as const;
  const max = { overageUnitPrice: MAIL_UNIT_PRICE_MAX, platformDailyLimit: MAIL_QUOTA_MAX, platformMonthlyLimit: MAIL_QUOTA_MAX };
  if (keys.every((k) => input[k] === undefined) || keys.some((k) => input[k] !== undefined && !isInt(input[k], max[k]))) return { ok: false as const };
  await db.$transaction(async (tx) => {
    // 한도 판정(reserveMail)과 같은 잠금 아래에서 바꾼다
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mail_quota'))`;
    const cur = await mailSettings(tx);
    const before = { overageUnitPrice: cur.overageUnitPrice, platformDailyLimit: cur.platformDailyLimit, platformMonthlyLimit: cur.platformMonthlyLimit };
    const data = Object.fromEntries(keys.map((k) => [k, (input[k] as number | undefined) ?? before[k]])) as typeof before;
    await tx.platformMailSetting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.mail_settings.update",
      targetType: "PlatformMailSetting",
      targetId: "1",
      before,
      after: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, settings: await getAdminMailSettings(db, admin) };
}

export async function updatePlanMailQuota(db: PrismaClient, admin: AdminSessionContext, code: string, input: { monthlyQuota?: unknown }, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "billing.price")) throw forbidden();
  if (!isInt(input.monthlyQuota, MAIL_QUOTA_MAX)) return { ok: false as const, reason: "invalid_quota" as const };
  const monthlyQuota = input.monthlyQuota;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mail_quota'))`;
    const before = await tx.subscriptionPlan.findUnique({ where: { code }, select: { id: true, mailMonthlyQuota: true } });
    if (!before) return { ok: false as const, reason: "not_found" as const };
    await tx.subscriptionPlan.update({ where: { code }, data: { mailMonthlyQuota: monthlyQuota } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.plan.mail_quota_update",
      targetType: "SubscriptionPlan",
      targetId: before.id,
      before: { mailMonthlyQuota: before.mailMonthlyQuota },
      after: { mailMonthlyQuota: monthlyQuota },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, plan: { code, mailMonthlyQuota: monthlyQuota } };
  });
}
