import type { MessageChannel, Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { MAIL_QUOTA_MAX, effectiveMailQuota, platformMailUsage, sellerMailUsage } from "../mail/quota";
import { decodeCursor, encodeCursor } from "../orders/read";
import { messageJobsHealthy } from "./jobs";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import {
  MESSAGE_AMOUNT_MAX,
  MESSAGE_CHANNELS,
  MESSAGE_FEE_NOTICE_VERSION,
  MESSAGE_UNIT_PRICE_MAX,
  balanceOf,
  channelPrices,
  grantFreeBalance,
  messageSettings,
} from "./balance";

// 발송 충전 잔액·단가·제공량 설정과 조회(docs/terms/SELLER_MESSAGE_FEE_NOTICE.md, messaging/balance.ts).
// - 파트너스: 잔액·사용 내역·잔액 부족 알림 기준·비용 안내 동의. 비용이 드는 설정이라 대표자만(SUBSCRIPTION_MANAGE).
// - 마스터 관리자: 충전 스위치·플랫폼 메일 한도·채널별 단가·플랜별 제공량·무상 지급. 바꾸기는 최고관리자만(billing.price), 보기는 platform.read.
//   단가·제공량은 적용 예정일(effectiveAt)을 둘 수 있다(서식 6절, 공지 발송 연결은 알림 기능이 생길 때). 모두 로그 추적.
type Meta = { ip?: string | null; userAgent?: string | null };
const isInt = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const LEDGER_PAGE_MAX = 200;

// 적용 예정일: 빼면 지금. ISO 시각 문자열이어야 하고, 지금보다 이르면 지금으로 본다.
function parseEffectiveAt(v: unknown, now: Date): Date | null | "invalid" {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > 40) return "invalid";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "invalid";
  return d > now ? d : null;
}

function requireAdminPermission(admin: AdminSessionContext, p: "platform.read" | "billing.price") {
  if (!adminCan(admin.admin.role, p)) throw forbidden();
}

// ---- 파트너스 ----

export async function getSellerMessageBalance(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const now = await dbNow(db);
  const [balance, settings, prices, mail, consent] = await Promise.all([
    balanceOf(db, ctx.sellerId),
    messageSettings(db),
    channelPrices(db, now),
    sellerMailUsage(db, ctx.sellerId, now),
    db.sellerMessageFeeConsent.findUnique({ where: { sellerId_version: { sellerId: ctx.sellerId, version: MESSAGE_FEE_NOTICE_VERSION } }, select: { version: true, consentedAt: true } }),
  ]);
  return { ...balance, chargingEnabled: settings.chargingEnabled, noticeVersion: MESSAGE_FEE_NOTICE_VERSION, consent, prices, mail };
}

export async function updateLowBalanceThreshold(db: PrismaClient, ctx: TenantContext, input: { lowBalanceThreshold?: unknown }) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  if (!isInt(input.lowBalanceThreshold, MESSAGE_AMOUNT_MAX)) return { ok: false as const };
  const value = input.lowBalanceThreshold;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "SellerMessageBalance" ("sellerId", "updatedAt") VALUES (${ctx.sellerId}::uuid, now()) ON CONFLICT ("sellerId") DO NOTHING`;
    const [before] = await tx.$queryRaw<{ lowBalanceThreshold: number }[]>`
      SELECT "lowBalanceThreshold" FROM "SellerMessageBalance" WHERE "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    await tx.sellerMessageBalance.update({ where: { sellerId: ctx.sellerId }, data: { lowBalanceThreshold: value } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.message_balance.threshold_update",
      targetType: "SellerMessageBalance",
      targetId: ctx.sellerId,
      before: { lowBalanceThreshold: before.lowBalanceThreshold },
      after: { lowBalanceThreshold: value },
    });
  });
  return { ok: true as const, balance: await balanceOf(db, ctx.sellerId) };
}

// 발송 비용 안내 동의(서식 7절). 지금 서식 버전만 받는다. 이미 동의했으면 그 기록 그대로(멱등).
export async function consentMessageFee(db: PrismaClient, ctx: TenantContext, input: { version?: unknown }) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  if (input.version !== MESSAGE_FEE_NOTICE_VERSION) return { ok: false as const };
  if (ctx.actorType !== "SELLER_USER" || !ctx.actorId) throw forbidden();
  const sellerUserId = ctx.actorId;
  const now = await dbNow(db);
  const row = await db.$transaction(async (tx) => {
    const existing = await tx.sellerMessageFeeConsent.findUnique({ where: { sellerId_version: { sellerId: ctx.sellerId, version: MESSAGE_FEE_NOTICE_VERSION } } });
    if (existing) return existing;
    const created = await tx.sellerMessageFeeConsent.upsert({
      where: { sellerId_version: { sellerId: ctx.sellerId, version: MESSAGE_FEE_NOTICE_VERSION } },
      create: { sellerId: ctx.sellerId, version: MESSAGE_FEE_NOTICE_VERSION, sellerUserId, consentedAt: now },
      update: {},
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.message_fee.consent",
      targetType: "SellerMessageFeeConsent",
      targetId: created.id,
      after: { version: created.version },
    });
    return created;
  });
  return { ok: true as const, consent: { version: row.version, consentedAt: row.consentedAt, sellerUserId: row.sellerUserId } };
}

// 사용 내역(서식 3-4): 최근 순 커서
export async function listSellerMessageLedger(db: PrismaClient, ctx: TenantContext, query: { cursor?: string | null; limit?: string | null }) {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const n = query.limit == null || query.limit === "" ? 50 : Number(query.limit);
  if (!Number.isInteger(n) || n < 1) return { ok: false as const };
  const take = Math.min(n, LEDGER_PAGE_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const where: Prisma.SellerMessageLedgerWhereInput = {
    sellerId: ctx.sellerId,
    ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
  };
  const rows = await db.sellerMessageLedger.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: { id: true, type: true, status: true, channel: true, quantity: true, unitPrice: true, paidAmount: true, freeAmount: true, reason: true, createdAt: true, finishedAt: true },
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return { ok: true as const, entries: page, nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null };
}

// ---- 마스터 관리자 ----

export async function getAdminMessageSettings(db: PrismaClient, admin: AdminSessionContext) {
  requireAdminPermission(admin, "platform.read");
  const now = await dbNow(db);
  const [settings, prices, plans, usage] = await Promise.all([
    messageSettings(db),
    channelPrices(db, now),
    db.subscriptionPlan.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true, mailMonthlyQuota: true, nextMailQuota: true, nextMailQuotaAt: true } }),
    platformMailUsage(db, now),
  ]);
  return {
    chargingEnabled: settings.chargingEnabled,
    platformDailyLimit: settings.platformDailyLimit,
    platformMonthlyLimit: settings.platformMonthlyLimit,
    noticeVersion: MESSAGE_FEE_NOTICE_VERSION,
    prices,
    plans: plans.map((p) => {
      const quota = effectiveMailQuota(p, now);
      const pending = p.nextMailQuota !== null && p.nextMailQuotaAt && p.nextMailQuotaAt > now;
      return { code: p.code, name: p.name, mailMonthlyQuota: quota, next: pending ? { mailMonthlyQuota: p.nextMailQuota, effectiveAt: p.nextMailQuotaAt } : null };
    }),
    usage,
  };
}

// 빼고 보내면 지금 값 유지. 충전 기능을 켤 때(꺼짐 → 켜짐)는 발송 충전 정기 작업(대조·멈춘 예약 정리)이 최근에 성공했어야 한다
// (messaging/jobs.ts, 아니면 jobs_not_running). 끄기는 언제든 된다.
export async function updateAdminMessageSettings(
  db: PrismaClient,
  admin: AdminSessionContext,
  input: { chargingEnabled?: unknown; platformDailyLimit?: unknown; platformMonthlyLimit?: unknown },
  meta: Meta = {},
) {
  requireAdminPermission(admin, "billing.price");
  const ints = ["platformDailyLimit", "platformMonthlyLimit"] as const;
  const invalid = { ok: false as const, reason: "invalid_message_settings" as const };
  if (input.chargingEnabled === undefined && ints.every((k) => input[k] === undefined)) return invalid;
  if (input.chargingEnabled !== undefined && typeof input.chargingEnabled !== "boolean") return invalid;
  if (ints.some((k) => input[k] !== undefined && !isInt(input[k], MAIL_QUOTA_MAX))) return invalid;
  const done = await db.$transaction(async (tx) => {
    // 한도 판정(reserveMail)과 같은 잠금 아래에서 바꾼다
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mail_quota'))`;
    const cur = await messageSettings(tx);
    const before = { chargingEnabled: cur.chargingEnabled, platformDailyLimit: cur.platformDailyLimit, platformMonthlyLimit: cur.platformMonthlyLimit };
    const after = {
      chargingEnabled: (input.chargingEnabled as boolean | undefined) ?? before.chargingEnabled,
      platformDailyLimit: (input.platformDailyLimit as number | undefined) ?? before.platformDailyLimit,
      platformMonthlyLimit: (input.platformMonthlyLimit as number | undefined) ?? before.platformMonthlyLimit,
    };
    if (after.chargingEnabled && !before.chargingEnabled && !(await messageJobsHealthy(tx, await dbNow(tx)))) return false;
    await tx.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, ...after }, update: after });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.message_settings.update", targetType: "PlatformMessageSetting", targetId: "1", before, after, ip: meta.ip, userAgent: meta.userAgent });
    return true;
  });
  if (!done) return { ok: false as const, reason: "jobs_not_running" as const };
  return { ok: true as const, settings: await getAdminMessageSettings(db, admin) };
}

export async function updateChannelPrice(db: PrismaClient, admin: AdminSessionContext, channel: string, input: { unitPrice?: unknown; effectiveAt?: unknown }, meta: Meta = {}) {
  requireAdminPermission(admin, "billing.price");
  if (!MESSAGE_CHANNELS.includes(channel as MessageChannel)) return { ok: false as const, reason: "not_found" as const };
  const now = await dbNow(db);
  const at = parseEffectiveAt(input.effectiveAt, now);
  if (!isInt(input.unitPrice, MESSAGE_UNIT_PRICE_MAX) || at === "invalid") return { ok: false as const, reason: "invalid_price" as const };
  const unitPrice = input.unitPrice;
  const ch = channel as MessageChannel;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "MessageChannelPrice" ("channel", "updatedAt") VALUES (${ch}::"MessageChannel", now()) ON CONFLICT ("channel") DO NOTHING`;
    const [cur] = await tx.$queryRaw<{ unitPrice: number; pendingUnitPrice: number | null; pendingEffectiveAt: Date | null }[]>`
      SELECT "unitPrice", "pendingUnitPrice", "pendingEffectiveAt" FROM "MessageChannelPrice" WHERE "channel" = ${ch}::"MessageChannel" FOR UPDATE`;
    // 이미 적용일이 지난 예정 단가는 지금 단가로 먼저 옮긴다
    const current = cur.pendingUnitPrice !== null && cur.pendingEffectiveAt && cur.pendingEffectiveAt <= now ? cur.pendingUnitPrice : cur.unitPrice;
    const data = at ? { unitPrice: current, pendingUnitPrice: unitPrice, pendingEffectiveAt: at } : { unitPrice, pendingUnitPrice: null, pendingEffectiveAt: null };
    await tx.messageChannelPrice.update({ where: { channel: ch }, data });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.message_price.update",
      targetType: "MessageChannelPrice",
      targetId: ch,
      before: { unitPrice: current },
      after: { unitPrice, effectiveAt: (at ?? now).toISOString() },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, price: (await channelPrices(db, now)).find((p) => p.channel === ch)! };
}

export async function updatePlanMailQuota(db: PrismaClient, admin: AdminSessionContext, code: string, input: { monthlyQuota?: unknown; effectiveAt?: unknown }, meta: Meta = {}) {
  requireAdminPermission(admin, "billing.price");
  const now = await dbNow(db);
  const at = parseEffectiveAt(input.effectiveAt, now);
  if (!isInt(input.monthlyQuota, MAIL_QUOTA_MAX) || at === "invalid") return { ok: false as const, reason: "invalid_quota" as const };
  const monthlyQuota = input.monthlyQuota;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mail_quota'))`;
    const plan = await tx.subscriptionPlan.findUnique({ where: { code }, select: { id: true, mailMonthlyQuota: true, nextMailQuota: true, nextMailQuotaAt: true } });
    if (!plan) return { ok: false as const, reason: "not_found" as const };
    const current = effectiveMailQuota(plan, now);
    const data = at ? { mailMonthlyQuota: current, nextMailQuota: monthlyQuota, nextMailQuotaAt: at } : { mailMonthlyQuota: monthlyQuota, nextMailQuota: null, nextMailQuotaAt: null };
    await tx.subscriptionPlan.update({ where: { code }, data });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.plan.mail_quota_update",
      targetType: "SubscriptionPlan",
      targetId: plan.id,
      before: { mailMonthlyQuota: current },
      after: { mailMonthlyQuota: monthlyQuota, effectiveAt: (at ?? now).toISOString() },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, plan: { code, mailMonthlyQuota: at ? current : monthlyQuota, next: at ? { mailMonthlyQuota: monthlyQuota, effectiveAt: at } : null } };
  });
}

// 무상 지급(최고관리자). 사유 1~200자, 금액 1원~1,000만 원, 요청 키(같은 키는 한 번만).
export async function grantSellerMessageBalance(
  db: PrismaClient,
  admin: AdminSessionContext,
  sellerId: string,
  input: { amount?: unknown; reason?: unknown; idempotencyKey?: unknown },
  meta: Meta = {},
) {
  requireAdminPermission(admin, "billing.price");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!isInt(input.amount, MESSAGE_AMOUNT_MAX) || input.amount < 1 || !reason || reason.length > 200 || !key || key.length > 100) return { ok: false as const, reason: "invalid_grant" as const };
  if (!(await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return { ok: false as const, reason: "not_found" as const };
  const r = await grantFreeBalance(db, { sellerId, amount: input.amount, reason, idempotencyKey: key, adminId: admin.admin.id, meta });
  return { ok: true as const, ledgerId: r.ledgerId, existing: r.existing, balance: await balanceOf(db, sellerId) };
}

// 파트너스 한 곳의 잔액·이번 달 메일 사용(platform.read)
export async function getAdminSellerMessageBalance(db: PrismaClient, admin: AdminSessionContext, sellerId: string) {
  requireAdminPermission(admin, "platform.read");
  if (!(await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return null;
  const [balance, mail] = await Promise.all([balanceOf(db, sellerId), sellerMailUsage(db, sellerId)]);
  return { ...balance, mail };
}
