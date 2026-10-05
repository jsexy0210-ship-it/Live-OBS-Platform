import { Prisma, type BuyerCoupon, type Coupon, type CouponBenefit, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { sellerCan } from "../authz/permissions";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import {
  benefitLabel,
  COUPON_LIMIT,
  couponExpiry,
  isUuid,
  normalizeCode,
  parseCoupon,
  quoteCoupon,
  type CouponInput,
  type CouponLine,
  type CouponQuoteFailure,
  type CouponRejection,
} from "./rules";

// 쿠폰(SA-035 쿠폰 관리 · SH-028 내 쿠폰함, 2026-10-04 대표님 지시). 규칙(MASTER 2026-10-04):
// - 만들기·고치기·발급 중지·직접 지급은 대표자·적립금(MEMBER_POINTS) 권한 직원만. 조회(집계)는 같은 쇼핑몰 파트너스 계정 누구나.
// - 1인 1장(BuyerCoupon 유니크), 주문당 1장(CouponRedemption.orderId 유니크). 발급 수량은 조건부 UPDATE로 한도를 넘지 않는다.
// - 쿠폰 사용은 주문 생성 트랜잭션에서 ISSUED → USED 조건부 UPDATE로 한 번만 성공한다(동시 주문 둘 중 하나만).
// - 전체 취소(결제 대기 취소·자동 취소·전액 환불)면 쿠폰을 되돌리고, 부분 환불이면 되돌리지 않는다.
// - 바꿀 때마다 로그 추적(감사 로그)에 남긴다. 기간 판단은 DB 시계(밀리초로 자름).
// - 잠금 원칙: 쿠폰을 바꾸거나 발급·삭제·사용하는 쓰기는 쿠폰 행 FOR UPDATE(lockCoupon) 아래에서 읽고 검사하고, 대상 회원은 회원 행 잠금으로
//   ACTIVE를 다시 본다(받기·주문은 회원 행 FOR SHARE를 먼저 잡고, 탈퇴만 FOR UPDATE. 공유 잠금끼리는 서로 막지 않아 교착이 없다).
//   쿠폰 수정은 쿠폰 행 → 쇼핑몰 행(NO KEY UPDATE) 순서. 복원은 사용 기록(CouponRedemption)·받은 쿠폰 행 조건부 UPDATE로 한 번만.
// - 잠금을 잡은 뒤에는 잠금 전에 읽은 값을 믿지 않는다. 잠긴 쿠폰 행(발급 방식·코드·기간·중지)과 잠금 뒤 시각(lockedNow, clock_timestamp)으로
//   모든 조건을 다시 검사하고, 받은 시각·만료도 그 시각으로 정한다(받기·코드·직접 지급·주문 견적 모두).

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };
export type CouponStatus = "live" | "scheduled" | "ended";

// 잠금을 잡은 뒤의 실제 시각(clock_timestamp, 밀리초로 자름). now()는 트랜잭션 시작 시각이라 잠금을 기다린 시간이 빠진다.
async function lockedNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}

async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', now()) AS now`;
  return rows[0].now;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

function statusOf(c: Pick<Coupon, "isActive" | "startsAt" | "endsAt">, now: Date): CouponStatus {
  if (!c.isActive || c.endsAt <= now) return "ended";
  return now < c.startsAt ? "scheduled" : "live";
}

function audit(db: Db, ctx: TenantContext, meta: AuditMeta, action: string, targetId: string, before: unknown, after: unknown) {
  return writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "Coupon", targetId, before, after, ip: meta.ip, userAgent: meta.userAgent });
}

const couponAudit = (c: Coupon) => ({
  name: c.name,
  issueMethod: c.issueMethod,
  code: c.code,
  benefit: c.benefit,
  value: c.value,
  maxDiscount: c.maxDiscount,
  minOrderAmount: c.minOrderAmount,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  validDays: c.validDays,
  issueLimit: c.issueLimit,
  productIds: c.productIds,
  excludeDiscounted: c.excludeDiscounted,
  allowWithReward: c.allowWithReward,
  isActive: c.isActive,
});

// ───────── 파트너스 관리자 ─────────

export type CouponStats = { used: number; discountTotal: number };

function couponView(c: Coupon, now: Date, stats: CouponStats) {
  return {
    ...couponAudit(c),
    id: c.id,
    issuedCount: c.issuedCount,
    benefitText: benefitLabel(c),
    status: statusOf(c, now),
    soldOut: c.issueLimit !== null && c.issuedCount >= c.issueLimit,
    used: stats.used,
    discountTotal: stats.discountTotal,
    createdAt: c.createdAt,
  };
}
export type CouponView = ReturnType<typeof couponView>;

// KST 달의 시작 시각(UTC)
function kstMonthStart(now: Date): Date {
  const k = new Date(now.getTime() + 9 * 3600_000);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - 9 * 3600_000);
}

// 쿠폰 목록과 집계(SA-035 상단 숫자·표). 사용·할인 총액은 되돌린(전체 취소) 사용을 뺀다.
export async function listCoupons(db: PrismaClient, ctx: TenantContext) {
  const now = await dbNow(db);
  const monthStart = kstMonthStart(now);
  const [rows, used, discounts, monthUse, monthOrders, grades, products] = await Promise.all([
    db.coupon.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    db.buyerCoupon.groupBy({ by: ["couponId"], where: { sellerId: ctx.sellerId, status: "USED" }, _count: { _all: true } }),
    db.couponRedemption.groupBy({ by: ["couponId"], where: { sellerId: ctx.sellerId, restoredAt: null }, _sum: { discountAmount: true } }),
    db.couponRedemption.aggregate({ where: { sellerId: ctx.sellerId, restoredAt: null, createdAt: { gte: monthStart } }, _count: { _all: true }, _sum: { discountAmount: true } }),
    db.order.count({ where: { sellerId: ctx.sellerId, createdAt: { gte: monthStart }, status: { not: "CANCELLED" } } }),
    db.memberGrade.findMany({
      where: { sellerId: ctx.sellerId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, displayName: true, _count: { select: { members: { where: { status: "ACTIVE", deletedAt: null } } } } },
    }),
    // 쿠폰에 들어 있는 적용 상품의 이름(지운 상품 포함). 고르기는 searchCouponProducts(이름 검색)로 한다.
    db.product.findMany({
      where: { sellerId: ctx.sellerId, id: { in: [...new Set((await db.coupon.findMany({ where: { sellerId: ctx.sellerId }, select: { productIds: true } })).flatMap((c) => c.productIds))] } },
      select: { id: true, name: true, deletedAt: true },
    }),
  ]);
  const usedBy = new Map(used.map((u) => [u.couponId, u._count._all]));
  const discountBy = new Map(discounts.map((d) => [d.couponId, d._sum.discountAmount ?? 0]));
  const coupons = rows.map((c) => couponView(c, now, { used: usedBy.get(c.id) ?? 0, discountTotal: discountBy.get(c.id) ?? 0 }));
  const weekLater = new Date(now.getTime() + 7 * 86_400_000);
  return {
    coupons,
    summary: {
      live: coupons.filter((c) => c.status === "live").length,
      monthUsed: monthUse._count._all,
      monthDiscount: monthUse._sum.discountAmount ?? 0,
      // 이번 달 쿠폰 쓴 주문 ÷ 이번 달 주문(취소 제외). 주문이 없으면 0.
      monthCouponOrderRate: monthOrders > 0 ? Math.round((Math.min(monthUse._count._all, monthOrders) / monthOrders) * 100) : 0,
      expiringSoon: coupons.filter((c) => c.status === "live" && new Date(c.endsAt) <= weekLater).length,
    },
    grades: grades.map((g) => ({ id: g.id, name: g.displayName, members: g._count.members })),
    products: products.map((p) => ({ id: p.id, name: p.name, deleted: p.deletedAt !== null })),
    canEdit: !ctx.readOnly && sellerCan(ctx, "MEMBER_POINTS"),
    now,
  };
}

// 쇼핑몰 단위 쿠폰 변경(만들기 개수·코드 중복)을 한 줄로. NO KEY UPDATE라 쇼핑몰을 가리키는 행 추가(받기·주문)는 막지 않는다.
const lockSellerCoupons = (tx: Tx, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR NO KEY UPDATE`;
// 쿠폰 행 잠금 뒤 지금 값. 수정·중지·받기·직접 지급이 모두 이 잠금 아래에서 읽고 검사한다.
async function lockCoupon(tx: Tx, sellerId: string, id: string): Promise<Coupon | null> {
  const [row] = await tx.$queryRaw<Coupon[]>`SELECT * FROM "Coupon" WHERE "id" = ${id}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return row ?? null;
}

// 적용 상품은 이 쇼핑몰의 지우지 않은 상품만
async function ownProducts(tx: Tx, sellerId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  return (await tx.product.count({ where: { sellerId, id: { in: ids }, deletedAt: null } })) === ids.length;
}

async function codeTaken(tx: Tx, sellerId: string, code: string | null, exceptId?: string): Promise<boolean> {
  if (!code) return false;
  return !!(await tx.coupon.findFirst({ where: { sellerId, code, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));
}

type Saved = { ok: true; coupon: CouponView } | { ok: false; reason: CouponRejection };

export async function createCoupon(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}): Promise<Saved> {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const p = parseCoupon(raw);
  if (!p.ok) return p;
  return db.$transaction(async (tx) => {
    await lockSellerCoupons(tx, ctx.sellerId);
    if ((await tx.coupon.count({ where: { sellerId: ctx.sellerId } })) >= COUPON_LIMIT) return { ok: false as const, reason: "too_many" as const };
    if (!(await ownProducts(tx, ctx.sellerId, p.v.productIds))) return { ok: false as const, reason: "invalid_products" as const };
    if (await codeTaken(tx, ctx.sellerId, p.v.code)) return { ok: false as const, reason: "code_taken" as const };
    const row = await tx.coupon.create({ data: { sellerId: ctx.sellerId, ...p.v } });
    await audit(tx, ctx, meta, "coupon.create", row.id, undefined, couponAudit(row));
    return { ok: true as const, coupon: couponView(row, await dbNow(tx), { used: 0, discountTotal: 0 }) };
  });
}

// 수정(전체 값). 한 장이라도 발급했으면 발급 방식·혜택·할인 값은 바꿀 수 없다(받은 쿠폰의 뜻이 바뀌지 않게). 한도는 발급 수 아래로 못 줄인다.
export async function updateCoupon(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}): Promise<Saved> {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(id)) throw notFound();
  const p = parseCoupon(raw);
  if (!p.ok) return p;
  return db.$transaction(async (tx) => {
    // 쿠폰 행을 먼저 잠그고 읽는다. 받기·직접 지급도 같은 행을 먼저 잠그므로 발급과 혜택 변경이 엇갈리지 않는다.
    // 잠금 순서는 쿠폰 행 → 쇼핑몰 행(코드 중복 검사용)으로 받기와 같게 둔다(교착 방지).
    const before = await lockCoupon(tx, ctx.sellerId, id);
    if (!before) throw notFound();
    await lockSellerCoupons(tx, ctx.sellerId);
    if (before.issuedCount > 0 && changesBenefit(before, p.v)) return { ok: false as const, reason: "method_locked" as const };
    if (p.v.issueLimit !== null && p.v.issueLimit < before.issuedCount) return { ok: false as const, reason: "issue_limit_below_issued" as const };
    if (!(await ownProducts(tx, ctx.sellerId, p.v.productIds))) return { ok: false as const, reason: "invalid_products" as const };
    if (await codeTaken(tx, ctx.sellerId, p.v.code, id)) return { ok: false as const, reason: "code_taken" as const };
    // 받은 쿠폰(쓴 쿠폰 포함)의 받은 시각보다 이른 종료는 거절한다(받은 시각 < 만료, BuyerCoupon_period_check).
    if (await tx.buyerCoupon.count({ where: { sellerId: ctx.sellerId, couponId: id, issuedAt: { gte: p.v.endsAt } } })) {
      return { ok: false as const, reason: "ends_before_issued" as const };
    }
    // 받은 쿠폰의 만료는 받을 때 정해진다. 사용 종료를 앞당기면 쓴 쿠폰까지 모든 받은 쿠폰의 만료를 맞춘다
    // (쓴 쿠폰이 전체 취소로 되돌아와도 새 종료 뒤에는 쓸 수 없게).
    const row = await tx.coupon.update({ where: { id }, data: p.v });
    if (row.endsAt < before.endsAt) {
      await tx.buyerCoupon.updateMany({ where: { sellerId: ctx.sellerId, couponId: id, expiresAt: { gt: row.endsAt } }, data: { expiresAt: row.endsAt } });
    }
    await audit(tx, ctx, meta, "coupon.update", id, couponAudit(before), couponAudit(row));
    return { ok: true as const, coupon: couponView(row, await dbNow(tx), await statsOf(tx, ctx.sellerId, id)) };
  });
}

const changesBenefit = (c: Coupon, v: CouponInput) =>
  c.issueMethod !== v.issueMethod || c.benefit !== v.benefit || c.value !== v.value || c.maxDiscount !== v.maxDiscount || c.code !== v.code;

async function statsOf(db: Db, sellerId: string, couponId: string): Promise<CouponStats> {
  const [used, sum] = await Promise.all([
    db.buyerCoupon.count({ where: { sellerId, couponId, status: "USED" } }),
    db.couponRedemption.aggregate({ where: { sellerId, couponId, restoredAt: null }, _sum: { discountAmount: true } }),
  ]);
  return { used, discountTotal: sum._sum.discountAmount ?? 0 };
}

// 발급 중지·다시 발급. 중지해도 이미 받은 쿠폰은 기간 안에 쓸 수 있다.
export async function setCouponActive(db: PrismaClient, ctx: TenantContext, id: string, isActive: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(id) || typeof isActive !== "boolean") throw notFound();
  return db.$transaction(async (tx) => {
    const before = await lockCoupon(tx, ctx.sellerId, id);
    if (!before) throw notFound();
    const row = await tx.coupon.update({ where: { id }, data: { isActive } });
    if (before.isActive !== isActive) await audit(tx, ctx, meta, isActive ? "coupon.resume" : "coupon.stop", id, { isActive: before.isActive }, { isActive });
    return couponView(row, await dbNow(tx), await statsOf(tx, ctx.sellerId, id));
  });
}

// 삭제: 한 장도 발급하지 않은 쿠폰만. 발급했으면 집계를 남기려고 지우지 않는다(발급 중지로 「종료」).
export async function deleteCoupon(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}): Promise<{ ok: true } | { ok: false; reason: "has_history" | "grade_benefit" }> {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    // 받기와 같은 쿠폰 행을 잠그고 발급 이력을 본다(그사이 받은 쿠폰이 있으면 has_history)
    const before = await lockCoupon(tx, ctx.sellerId, id);
    if (!before) throw notFound();
    // 회원 등급의 승급 쿠폰으로 연결된 쿠폰은 지울 수 없다(등급 혜택에서 먼저 풀어야 한다)
    if ((await tx.memberGrade.count({ where: { sellerId: ctx.sellerId, promotionCouponId: id } })) > 0) return { ok: false as const, reason: "grade_benefit" as const };
    if (before.issuedCount > 0 || (await tx.buyerCoupon.count({ where: { couponId: id } })) > 0) return { ok: false as const, reason: "has_history" as const };
    await tx.coupon.delete({ where: { id } });
    await audit(tx, ctx, meta, "coupon.delete", id, couponAudit(before), undefined);
    return { ok: true as const };
  });
}

export const GRANT_MAX = 10_000;
export type GrantFailure = "invalid_target" | "not_manual" | "not_started" | "ended" | "issue_limit" | "too_many_members";

// 직접 지급(발급 방식 「직접 지급」 쿠폰만): 고른 등급의 회원 전체 + 고른 회원. 이미 받은 회원은 건너뛴다.
// 쿠폰 행을 잠그고 넣으므로 동시에 지급해도 한도를 넘지 않는다. 한도를 넘으면 아무도 받지 않는다.
export async function grantCoupon(
  db: PrismaClient,
  ctx: TenantContext,
  id: string,
  raw: unknown,
  meta: AuditMeta = {},
): Promise<{ ok: true; granted: number; skipped: number } | { ok: false; reason: GrantFailure }> {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(id)) throw notFound();
  const b = raw && typeof raw === "object" ? (raw as { gradeIds?: unknown; buyerMemberIds?: unknown }) : {};
  const gradeIds = b.gradeIds ?? [];
  const memberIds = b.buyerMemberIds ?? [];
  if (!Array.isArray(gradeIds) || !Array.isArray(memberIds) || !gradeIds.every(isUuid) || !memberIds.every(isUuid)) return { ok: false, reason: "invalid_target" };
  if (gradeIds.length === 0 && memberIds.length === 0) return { ok: false, reason: "invalid_target" };
  if (gradeIds.length > 50 || memberIds.length > GRANT_MAX) return { ok: false, reason: "too_many_members" };
  return db.$transaction(async (tx) => {
    const coupon = await lockCoupon(tx, ctx.sellerId, id);
    if (!coupon) throw notFound();
    if (coupon.issueMethod !== "MANUAL") return { ok: false as const, reason: "not_manual" as const };
    // 잠금 뒤 시각으로 기간을 보고 받은 시각·만료를 정한다
    const now = await lockedNow(tx);
    // 받기·코드와 같게 사용 기간 안에서만 지급한다(시작 전·종료·중지는 거절)
    const status = statusOf(coupon, now);
    if (status !== "live") return { ok: false as const, reason: status === "scheduled" ? ("not_started" as const) : ("ended" as const) };
    if ((await tx.memberGrade.count({ where: { sellerId: ctx.sellerId, id: { in: gradeIds } } })) !== gradeIds.length) return { ok: false as const, reason: "invalid_target" as const };
    // 회원 행을 공유 잠금으로 읽어 탈퇴(FOR UPDATE)와 엇갈리지 않게 한다. 탈퇴가 먼저 끝나면 그 회원은 빠진다.
    const members = await tx.$queryRaw<{ id: string }[]>`
      SELECT m."id" FROM "BuyerMember" m
      WHERE m."sellerId" = ${ctx.sellerId}::uuid AND m."status" = 'ACTIVE' AND m."deletedAt" IS NULL
        AND (m."gradeId" = ANY(${gradeIds}::uuid[]) OR m."id" = ANY(${memberIds}::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM "BuyerCoupon" b WHERE b."couponId" = ${id}::uuid AND b."buyerMemberId" = m."id")
      ORDER BY m."id"
      LIMIT ${GRANT_MAX + 1}
      FOR SHARE OF m`;
    if (members.length > GRANT_MAX) return { ok: false as const, reason: "too_many_members" as const };
    if (coupon.issueLimit !== null && coupon.issuedCount + members.length > coupon.issueLimit) return { ok: false as const, reason: "issue_limit" as const };
    const expiresAt = couponExpiry(coupon, now);
    if (members.length > 0) {
      await tx.buyerCoupon.createMany({ data: members.map((m) => ({ sellerId: ctx.sellerId, couponId: id, buyerMemberId: m.id, issuedAt: now, expiresAt })) });
      await tx.coupon.update({ where: { id }, data: { issuedCount: { increment: members.length } } });
    }
    const total = await tx.buyerMember.count({ where: { sellerId: ctx.sellerId, status: "ACTIVE", deletedAt: null, OR: [{ gradeId: { in: gradeIds } }, { id: { in: memberIds } }] } });
    // 회원 id는 남기지 않고 고른 등급·회원 수와 지급 수만 남긴다
    await audit(tx, ctx, meta, "coupon.grant", id, undefined, { gradeIds, memberCount: memberIds.length, granted: members.length, skipped: total - members.length });
    return { ok: true as const, granted: members.length, skipped: total - members.length };
  });
}

// 등급 승급 쿠폰 자동 지급(shop-member-grades): 직접 지급 방식 쿠폰을 한 회원에게 한 장 준다. 이미 받았거나(1인 1장, 같은 쿠폰은 다시 지급하지 않음) 기간·발급 중지·수량 한도로 줄 수 없으면 주지 않는다.
// 쿠폰 행을 잠그고 수량은 조건부 UPDATE로 지켜 동시 승급·직접 지급과 겹쳐도 한도를 넘지 않는다. 호출하는 쪽 트랜잭션 안에서 부른다.
export async function issueCouponToMember(tx: Tx, o: { sellerId: string; couponId: string; buyerMemberId: string }): Promise<"issued" | "already" | "unavailable" | "sold_out"> {
  const coupon = await lockCoupon(tx, o.sellerId, o.couponId);
  if (!coupon || coupon.issueMethod !== "MANUAL") return "unavailable";
  const now = await lockedNow(tx);
  if (statusOf(coupon, now) !== "live") return "unavailable";
  if (await tx.buyerCoupon.findFirst({ where: { couponId: coupon.id, buyerMemberId: o.buyerMemberId }, select: { id: true } })) return "already";
  const inc = await tx.$executeRaw`
    UPDATE "Coupon" SET "issuedCount" = "issuedCount" + 1
    WHERE "id" = ${coupon.id}::uuid AND "sellerId" = ${o.sellerId}::uuid AND ("issueLimit" IS NULL OR "issuedCount" < "issueLimit")`;
  if (inc !== 1) return "sold_out";
  await tx.buyerCoupon.create({ data: { sellerId: o.sellerId, couponId: coupon.id, buyerMemberId: o.buyerMemberId, issuedAt: now, expiresAt: couponExpiry(coupon, now) } });
  return "issued";
}

// 적용 상품 고르기: 이 쇼핑몰의 지우지 않은 상품을 이름으로 찾는다(대소문자 무시, 20개). 상품 관리 권한이 없는 적립금 직원도 쓴다.
export async function searchCouponProducts(db: PrismaClient, ctx: TenantContext, q: unknown) {
  const term = typeof q === "string" ? q.trim().slice(0, 50) : "";
  if (!term) return [];
  return db.product.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null, name: { contains: term, mode: "insensitive" } },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 20,
  });
}

// 배송비 무료 쿠폰을 쓴 주문은 구매자가 낸 배송비가 0원이다(환불의 처음 배송비·반품 배송비 왕복 판단, queue/service.ts).
export const chargedShippingFee = (o: { shippingFee: number; couponRedemption: { benefit: CouponBenefit } | null }) =>
  o.couponRedemption?.benefit === "FREE_SHIPPING" ? 0 : o.shippingFee;

// ───────── 구매자 쿠폰함 ─────────

export type BuyerScope = { sellerId: string; buyerMemberId: string };
export type BuyerCouponFailure = "coupon_not_found" | "already_issued" | "sold_out" | "shop_unavailable" | "code_attempts";

export const BUYER_COUPON_MESSAGES: Record<BuyerCouponFailure, string> = {
  coupon_not_found: "지금은 받을 수 없는 쿠폰이에요",
  already_issued: "이미 받은 쿠폰이에요. 쿠폰함에서 확인해 보세요",
  sold_out: "준비한 수량이 끝났어요",
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  code_attempts: "코드를 여러 번 잘못 넣었어요. 10분 뒤에 다시 해 주세요",
};
// 코드 입력 화면 문구(SH-028 「코드 오류」)
export const CODE_MESSAGES: Record<BuyerCouponFailure, string> = {
  ...BUYER_COUPON_MESSAGES,
  coupon_not_found: "맞는 코드가 아니에요. 대소문자 없이 다시 확인해 주세요",
  already_issued: "이미 등록한 코드예요. 쿠폰함에서 확인해 보세요",
  sold_out: "준비한 수량이 끝났어요. 다음 방송 코드를 기다려 주세요",
};

const publicCoupon = (c: Coupon) => ({
  couponId: c.id,
  name: c.name,
  benefit: c.benefit,
  value: c.value,
  maxDiscount: c.maxDiscount,
  benefitText: benefitLabel(c),
  minOrderAmount: c.minOrderAmount,
  excludeDiscounted: c.excludeDiscounted,
  allowWithReward: c.allowWithReward,
  productScoped: c.productIds.length > 0,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  validDays: c.validDays,
});

function mineView(bc: BuyerCoupon & { coupon: Coupon }, now: Date) {
  const state = bc.status === "USED" ? "used" : bc.expiresAt <= now ? "expired" : now < bc.coupon.startsAt ? "upcoming" : "usable";
  return { ...publicCoupon(bc.coupon), issuedAt: bc.issuedAt, expiresAt: bc.expiresAt, usedAt: bc.usedAt, state };
}

// 쓸 수 있는 쿠폰(곧 끝나는 순)·받을 수 있는 쿠폰(내려받기 방식)·지난 쿠폰(사용·기간 지남, 최근 50개)
export const CLAIMABLE_PAGE = 50;
export const CLAIMABLE_MAX = 500;
// claimableLimit: 받을 수 있는 쿠폰을 몇 개까지 줄지(기본 50, 「더 보기」로 50개씩 늘림, 500까지).
// 수량 소진·기간·중지·이미 받음은 DB에서 먼저 거른 뒤 개수를 자른다(소진 쿠폰이 앞자리를 차지해 받을 수 있는 쿠폰이 빠지지 않게).
export async function buyerCouponBox(db: PrismaClient, scope: BuyerScope, claimableLimit = CLAIMABLE_PAGE) {
  const limit = Math.min(Math.max(Math.floor(claimableLimit) || CLAIMABLE_PAGE, 1), CLAIMABLE_MAX);
  const now = await dbNow(db);
  const [mine, claimableIds] = await Promise.all([
    db.buyerCoupon.findMany({ where: scope, include: { coupon: true }, orderBy: [{ expiresAt: "asc" }, { id: "asc" }] }),
    db.$queryRaw<{ id: string }[]>`
      SELECT c."id" FROM "Coupon" c
      WHERE c."sellerId" = ${scope.sellerId}::uuid AND c."issueMethod" = 'DOWNLOAD' AND c."isActive"
        AND c."startsAt" <= ${now} AND c."endsAt" > ${now}
        AND (c."issueLimit" IS NULL OR c."issuedCount" < c."issueLimit")
        AND NOT EXISTS (SELECT 1 FROM "BuyerCoupon" b WHERE b."couponId" = c."id" AND b."buyerMemberId" = ${scope.buyerMemberId}::uuid)
      ORDER BY c."endsAt" ASC, c."id" ASC
      LIMIT ${limit + 1}`,
  ]);
  const ids = claimableIds.slice(0, limit).map((r) => r.id);
  const rows = new Map((await db.coupon.findMany({ where: { id: { in: ids } } })).map((c) => [c.id, c]));
  const views = mine.map((bc) => mineView(bc, now));
  return {
    usable: views.filter((v) => v.state === "usable" || v.state === "upcoming"),
    claimable: ids.map((id) => publicCoupon(rows.get(id)!)),
    claimableMore: claimableIds.length > limit,
    past: views
      .filter((v) => v.state === "used" || v.state === "expired")
      .sort((a, b) => (b.usedAt ?? b.expiresAt).getTime() - (a.usedAt ?? a.expiresAt).getTime())
      .slice(0, 50),
    now,
  };
}

type IssueResult = { ok: true; coupon: ReturnType<typeof mineView> } | { ok: false; reason: BuyerCouponFailure };

// 코드 입력: 같은 회원이 10분에 10번 넘게 틀리면 잠시 막는다(코드 맞히기 방지). 틀린 시도는 로그 추적에 남긴다.
export const CODE_ATTEMPT_LIMIT = 10;
export const CODE_ATTEMPT_WINDOW_MS = 10 * 60_000;

// 받기(내려받기·코드 공통). 발급 수는 조건부 UPDATE로 한도 안에서만 늘리고, 같은 회원이 두 번 받으면 유니크 키로 막아 전체를 되돌린다.
// countAttempts(코드 입력): 회원별 트랜잭션 잠금 아래에서 틀린 횟수를 세고 틀린 시도를 기록해, 동시에 여러 번 넣어도 한도를 넘지 않는다.
async function issue(
  db: PrismaClient,
  scope: BuyerScope,
  find: (tx: Tx, now: Date) => Promise<Coupon | null>,
  // 잠긴 쿠폰 행이 이 받기 방식에 맞는지(내려받기 방식·코드 값). 잠금 전에 찾은 값은 믿지 않는다.
  matches: (c: Coupon) => boolean,
  action: string,
  meta: AuditMeta,
  countAttempts = false,
): Promise<IssueResult> {
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  try {
    return await db.$transaction(async (tx) => {
      // 탈퇴와 겹치지 않게 회원 행을 공유 잠금(주문 생성과 같은 방식)
      const [member] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      if (countAttempts) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`coupon_code:${member.id}`}, 0))`;
      const now = await dbNow(tx);
      if (countAttempts) {
        const failed = await tx.auditLog.count({
          where: { action: "buyer_coupon.code_failed", actorId: member.id, sellerId: scope.sellerId, createdAt: { gt: new Date(now.getTime() - CODE_ATTEMPT_WINDOW_MS) } },
        });
        if (failed >= CODE_ATTEMPT_LIMIT) return { ok: false as const, reason: "code_attempts" as const };
      }
      const found = await find(tx, now);
      // 쿠폰 행을 잠그고, 잠긴 값과 잠금 뒤 시각으로 다시 검사한다(그사이 판매자의 수정·중지·종료와 엇갈리지 않게)
      const locked = found && (await lockCoupon(tx, scope.sellerId, found.id));
      const issuedAt = await lockedNow(tx);
      const coupon = locked && matches(locked) && statusOf(locked, issuedAt) === "live" ? locked : null;
      if (!coupon) {
        if (countAttempts) {
          await writeAudit(tx, { actorType: "BUYER", actorId: member.id, sellerId: scope.sellerId, action: "buyer_coupon.code_failed", ip: meta.ip, userAgent: meta.userAgent });
        }
        return { ok: false as const, reason: "coupon_not_found" as const };
      }
      if (await tx.buyerCoupon.findFirst({ where: { couponId: coupon.id, buyerMemberId: member.id }, select: { id: true } })) {
        return { ok: false as const, reason: "already_issued" as const };
      }
      // 수량 한도는 쿠폰 행 잠금 아래 조건부 UPDATE로 지킨다
      const inc = await tx.$executeRaw`
        UPDATE "Coupon" SET "issuedCount" = "issuedCount" + 1
        WHERE "id" = ${coupon.id}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND ("issueLimit" IS NULL OR "issuedCount" < "issueLimit")`;
      if (inc !== 1) return { ok: false as const, reason: "sold_out" as const };
      const bc = await tx.buyerCoupon.create({
        data: { sellerId: scope.sellerId, couponId: coupon.id, buyerMemberId: member.id, issuedAt, expiresAt: couponExpiry(coupon, issuedAt) },
        include: { coupon: true },
      });
      await writeAudit(tx, { actorType: "BUYER", actorId: member.id, sellerId: scope.sellerId, action, targetType: "Coupon", targetId: coupon.id, ip: meta.ip, userAgent: meta.userAgent });
      return { ok: true as const, coupon: mineView(bc, issuedAt) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "already_issued" };
    throw e;
  }
}

export function downloadCoupon(db: PrismaClient, scope: BuyerScope, couponId: string, meta: AuditMeta = {}) {
  if (!isUuid(couponId)) return Promise.resolve({ ok: false as const, reason: "coupon_not_found" as const });
  return issue(
    db,
    scope,
    (tx) => tx.coupon.findFirst({ where: { id: couponId, sellerId: scope.sellerId, issueMethod: "DOWNLOAD" } }),
    (c) => c.issueMethod === "DOWNLOAD",
    "buyer_coupon.download",
    meta,
  );
}

export function redeemCouponCode(db: PrismaClient, scope: BuyerScope, rawCode: unknown, meta: AuditMeta = {}): Promise<IssueResult> {
  const code = normalizeCode(rawCode);
  return issue(
    db,
    scope,
    async (tx) => (code ? tx.coupon.findFirst({ where: { sellerId: scope.sellerId, code, issueMethod: "CODE" } }) : null),
    (c) => c.issueMethod === "CODE" && c.code === code,
    "buyer_coupon.code",
    meta,
    true,
  );
}

// ───────── 주문 연동(orders/create.ts·queue/service.ts·orders/overdue.ts) ─────────

export type OrderCouponFailure = "coupon_unavailable" | "coupon_zero_total" | CouponQuoteFailure;
// 주문서 문구(해요체)
export const ORDER_COUPON_MESSAGES: Record<OrderCouponFailure, string> = {
  coupon_unavailable: "쓸 수 없는 쿠폰이에요. 쿠폰함에서 확인해 주세요",
  coupon_not_applicable: "이 주문에는 쓸 수 없는 쿠폰이에요",
  coupon_min_order: "쿠폰 최소 주문 금액을 채우지 못했어요",
  // 결제 금액이 0원이 되는 쿠폰은 당분간 받지 않는다(MASTER 2026-10-04 보수적 기본값, 대표님 확정 대기)
  coupon_zero_total: "이 주문에는 쿠폰을 쓸 수 없어요. 결제 금액이 0원이 돼요",
};
export const isOrderCouponFailure = (r: string): r is OrderCouponFailure => r in ORDER_COUPON_MESSAGES;

export type AppliedCoupon = { couponId: string; buyerCouponId: string; benefit: CouponBenefit; discountAmount: number; itemDiscounts: Record<string, number> };

// 주문 품목(옵션)별 쿠폰 할인 배분액. 사용 기록이 없거나 되돌렸으면 0이 아니라 배분 그대로(환불·적립은 주문 당시 결제 기준).
export function itemCouponDiscount(r: { itemDiscounts: Prisma.JsonValue } | null | undefined, optionId: string): number {
  const m = r?.itemDiscounts;
  const v = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>)[optionId] : undefined;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
}

// 주문에 쓸 쿠폰 확인·할인 계산(주문 생성 트랜잭션 안, 잠금 뒤 DB 시계). couponId가 없으면 null.
// 본인이 받은(ISSUED) 쿠폰이고 사용 기간(시작 ≤ 지금 < 만료) 안이어야 한다. 발급 중지된 쿠폰도 받은 쿠폰은 쓸 수 있다.
export async function quoteOrderCoupon(
  tx: Tx,
  o: { sellerId: string; buyerMemberId: string; couponId: unknown; now: Date; lines: CouponLine[]; shippingFee: number },
): Promise<{ ok: true; applied: AppliedCoupon | null } | { ok: false; reason: OrderCouponFailure }> {
  if (o.couponId === undefined || o.couponId === null) return { ok: true, applied: null };
  if (!isUuid(o.couponId)) return { ok: false, reason: "coupon_unavailable" };
  // 쿠폰 행을 잠그고 지금 값으로 검사한다(그사이 판매자의 수정·중지와 엇갈리지 않게)
  if (!(await lockCoupon(tx, o.sellerId, o.couponId))) return { ok: false, reason: "coupon_unavailable" };
  // 잠금을 기다린 사이 시각이 지났을 수 있어 잠금 뒤 시각으로 기간을 본다
  const now = await lockedNow(tx);
  const bc = await tx.buyerCoupon.findFirst({
    where: { sellerId: o.sellerId, buyerMemberId: o.buyerMemberId, couponId: o.couponId, status: "ISSUED", expiresAt: { gt: now }, coupon: { startsAt: { lte: now }, endsAt: { gt: now } } },
    include: { coupon: true },
  });
  if (!bc) return { ok: false, reason: "coupon_unavailable" };
  const q = quoteCoupon(bc.coupon, o.lines, o.shippingFee);
  if (!q.ok) return q;
  const total = o.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0) + o.shippingFee;
  if (total - q.discountAmount <= 0) return { ok: false, reason: "coupon_zero_total" };
  return { ok: true, applied: { couponId: bc.couponId, buyerCouponId: bc.id, benefit: bc.coupon.benefit, discountAmount: q.discountAmount, itemDiscounts: q.itemDiscounts } };
}

// 동시에 같은 쿠폰을 쓴 다른 주문이 먼저 끝났을 때. 주문 생성 트랜잭션을 통째로 되돌린다.
export class CouponTaken extends Error {}

// 쿠폰 사용 기록(주문을 만든 뒤 같은 트랜잭션). ISSUED → USED 조건부 UPDATE가 한 번만 성공하므로 같은 쿠폰을 두 주문에 쓰지 못한다.
export async function useOrderCoupon(tx: Tx, o: { sellerId: string; buyerMemberId: string; orderId: string; applied: AppliedCoupon; now: Date }) {
  const used = await tx.buyerCoupon.updateMany({
    where: { id: o.applied.buyerCouponId, sellerId: o.sellerId, buyerMemberId: o.buyerMemberId, status: "ISSUED", expiresAt: { gt: o.now } },
    data: { status: "USED", usedAt: o.now },
  });
  if (used.count !== 1) throw new CouponTaken();
  await tx.couponRedemption.create({
    data: { sellerId: o.sellerId, orderId: o.orderId, couponId: o.applied.couponId, buyerCouponId: o.applied.buyerCouponId, benefit: o.applied.benefit, discountAmount: o.applied.discountAmount, itemDiscounts: o.applied.itemDiscounts, createdAt: o.now },
  });
  await writeAudit(tx, {
    actorType: "BUYER",
    actorId: o.buyerMemberId,
    sellerId: o.sellerId,
    action: "order.coupon.use",
    targetType: "Order",
    targetId: o.orderId,
    after: { couponId: o.applied.couponId, benefit: o.applied.benefit, discountAmount: o.applied.discountAmount },
  });
}

// 전체 취소면 쓴 쿠폰을 되돌린다(받은 쿠폰의 만료는 그대로라 기간이 지났으면 「기간 지남」). 한 번만 되돌린다.
export async function restoreOrderCoupon(tx: Tx, o: { sellerId: string; orderId: string; now: Date; reason: string }) {
  const rows = await tx.$queryRaw<{ buyerCouponId: string; couponId: string }[]>`
    UPDATE "CouponRedemption" SET "restoredAt" = ${o.now}
    WHERE "orderId" = ${o.orderId}::uuid AND "sellerId" = ${o.sellerId}::uuid AND "restoredAt" IS NULL
    RETURNING "buyerCouponId", "couponId"`;
  if (rows.length === 0) return false;
  await tx.buyerCoupon.updateMany({ where: { id: rows[0].buyerCouponId, sellerId: o.sellerId, status: "USED" }, data: { status: "ISSUED", usedAt: null } });
  await writeAudit(tx, { actorType: "SYSTEM", sellerId: o.sellerId, action: "order.coupon.restore", targetType: "Order", targetId: o.orderId, reason: o.reason, after: { couponId: rows[0].couponId } });
  return true;
}

// 탈퇴: 쓰지 않았고 주문 기록과 이어지지 않은 쿠폰은 지운다. 주문에 쓴(또는 쓴 뒤 되돌린) 쿠폰은 주문 할인 기록이라 주문과 함께 남긴다.
export async function deleteUnusedBuyerCoupons(tx: Tx, scope: BuyerScope) {
  const r = await tx.buyerCoupon.deleteMany({ where: { ...scope, status: "ISSUED", redemptions: { none: {} } } });
  return r.count;
}
