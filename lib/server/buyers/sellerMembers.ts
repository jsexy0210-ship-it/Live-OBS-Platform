import type { BuyerMemberStatus, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { decodeCursor, encodeCursor, kstDayStart } from "../orders/read";
import { canViewCustomerPii, requireSellerRead, type TenantContext } from "../tenant/context";

// 파트너스 회원 목록·상세(MEMBER_POINTS). 항상 ctx.sellerId 범위만 보고, 다른 쇼핑몰 회원은 없음(404)으로 다룬다.
// 탈퇴한 회원(deletedAt, 분리 보관)은 일반 목록·상세에서 없는 회원으로 다룬다(PRODUCT_SCOPE 탈퇴 규칙, buyers/withdraw.ts).
// 이름·휴대폰은 CUSTOMER_PII_VIEW가 있을 때만 응답에 넣고 검색하며, 넣었거나 그것으로 찾았으면 customer.pii.view를 남긴다
// (orders/read.ts와 같은 기준, 대표님 결정 2026-10-02).
export const SELLER_MEMBER_PAGE_DEFAULT = 10;
export const SELLER_MEMBER_PAGE_MAX = 200;
const LIST_STATUSES: readonly BuyerMemberStatus[] = ["ACTIVE", "DORMANT"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// status: ACTIVE·DORMANT·RESTRICTED(구매 제한 중)·NORMAL(활동 중이고 구매 제한 없음). 탈퇴 회원은 목록에 없다.
// gradeIds: 쉼표로 이은 등급 id(최대 20). joinedFrom·joinedTo: KST 날짜(YYYY-MM-DD, 끝 날짜 포함).
// lastOrder: 30d·90d(그 기간 안에 주문) · over90d(90일 넘게 없음, 주문한 적 없는 회원 포함). qType: nickname·name·phoneLast4.
// marketing·hasBalance·hasMemo: "true"이면 걸러낸다. sort: joined(가입일, 기본)·lastOrder·spent·reward(모두 내림차순).
export type SellerMemberListQuery = {
  q?: string | null;
  qType?: string | null;
  gradeId?: string | null;
  gradeIds?: string | null;
  status?: string | null;
  joinedFrom?: string | null;
  joinedTo?: string | null;
  lastOrder?: string | null;
  marketing?: string | null;
  hasBalance?: string | null;
  hasMemo?: string | null;
  sort?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

const STATUS_FILTERS = ["ACTIVE", "DORMANT", "RESTRICTED", "NORMAL"];
const Q_TYPES = ["nickname", "name", "phoneLast4"];
const LAST_ORDERS = ["30d", "90d", "over90d"];
const SORTS = ["joined", "lastOrder", "spent", "reward"];
const GRADE_IDS_MAX = 20;
const DAY_MS = 24 * 3600_000;
const flag = (v: string | null | undefined) => (v == null || v === "" ? false : v === "true" ? true : null);
const restrictedWhere = (now: Date): Prisma.BuyerMemberWhereInput => ({ purchaseRestrictions: { some: { liftedAt: null, endsAt: { gt: now } } } });

const LIST_SELECT = {
  id: true,
  broadcastNickname: true,
  name: true,
  phone: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  marketingConsentAt: true,
  grade: { select: { id: true, displayName: true } },
} as const satisfies Prisma.BuyerMemberSelect;

type MemberRow = Prisma.BuyerMemberGetPayload<{ select: typeof LIST_SELECT }>;

function view(m: MemberRow, pii: boolean) {
  return {
    id: m.id,
    broadcastNickname: m.broadcastNickname,
    ...(pii ? { name: m.name, phone: m.phone } : {}),
    grade: m.grade,
    status: m.status,
    marketingConsent: m.marketingConsentAt !== null,
    createdAt: m.createdAt,
    lastLoginAt: m.lastLoginAt,
  };
}

type Aggregates = { count: Map<string, number>; lastOrderAt: Map<string, Date>; paid: Map<string, number>; balance: Map<string, number> };

// 상세와 같은 집계 범위(법정 보관 주문 제외). memberIds가 없으면 쇼핑몰 전체(정렬용)를 센다.
async function memberAggregates(db: PrismaClient, sellerId: string, memberIds?: string[]): Promise<Aggregates> {
  const orders = { sellerId, ...(memberIds ? { buyerMemberId: { in: memberIds } } : {}), legalHoldAt: null } as const;
  const [counts, paid, balances] = memberIds && !memberIds.length ? [[], [], []] : await Promise.all([
    db.order.groupBy({ by: ["buyerMemberId"], where: orders, _count: { _all: true }, _max: { createdAt: true } }),
    db.order.groupBy({ by: ["buyerMemberId"], where: { ...orders, paidAt: { not: null } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.rewardBalance.findMany({ where: { sellerId, ...(memberIds ? { buyerMemberId: { in: memberIds } } : {}) }, select: { buyerMemberId: true, balance: true } }),
  ]);
  return {
    count: new Map(counts.map((r) => [r.buyerMemberId, r._count._all])),
    lastOrderAt: new Map(counts.flatMap((r) => (r._max.createdAt ? [[r.buyerMemberId, r._max.createdAt] as const] : []))),
    paid: new Map(paid.map((r) => [r.buyerMemberId, (r._sum.totalAmount ?? 0) - (r._sum.refundAmount ?? 0)])),
    balance: new Map(balances.map((r) => [r.buyerMemberId, r.balance])),
  };
}

// 쇼핑몰 안 가입 순번(가입 시각·id 순, 탈퇴 회원 포함). 목록의 「번호」 열.
async function joinNumbers(db: PrismaClient, sellerId: string, memberIds: string[]) {
  if (!memberIds.length) return new Map<string, number>();
  const rows = await db.$queryRaw<{ id: string; n: bigint }[]>`
    SELECT "id", "n" FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS "n" FROM "BuyerMember" WHERE "sellerId" = ${sellerId}::uuid) t
    WHERE "id" = ANY(${memberIds}::uuid[])`;
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

// 회원 목록. 기본은 가입 시각 내림차순 (createdAt, id) 커서 페이지, sort가 lastOrder·spent·reward이면 집계값 내림차순(같으면 가입 순) 위치 커서.
// 잘못된 값이면 { ok: false }. q: 방송 닉네임(부분 일치)은 누구나, 이름(부분 일치)·휴대폰 끝 4자리(숫자 4자리)는 CUSTOMER_PII_VIEW가 있을 때만 찾는다.
export async function listSellerMembers(db: PrismaClient, ctx: TenantContext, query: SellerMemberListQuery, now = new Date()) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? SELLER_MEMBER_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, SELLER_MEMBER_PAGE_MAX);
  const sort = query.sort || "joined";
  if (!SORTS.includes(sort)) return { ok: false as const };
  const byJoined = sort === "joined";
  const cursor = byJoined && query.cursor ? decodeCursor(query.cursor) : null;
  const offset = !byJoined && query.cursor ? (/^\d{1,9}$/.test(query.cursor) ? Number(query.cursor) : null) : 0;
  if (query.cursor && (byJoined ? !cursor : offset === null)) return { ok: false as const };
  const status = query.status || null;
  if (status && !STATUS_FILTERS.includes(status)) return { ok: false as const };
  if (query.gradeId && !UUID_RE.test(query.gradeId)) return { ok: false as const };
  const gradeIds = query.gradeIds ? query.gradeIds.split(",") : [];
  if (gradeIds.length > GRADE_IDS_MAX || gradeIds.some((g) => !UUID_RE.test(g))) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };
  if (query.qType && !Q_TYPES.includes(query.qType)) return { ok: false as const };
  if (query.lastOrder && !LAST_ORDERS.includes(query.lastOrder)) return { ok: false as const };
  const marketing = flag(query.marketing);
  const hasBalance = flag(query.hasBalance);
  const hasMemo = flag(query.hasMemo);
  if (marketing === null || hasBalance === null || hasMemo === null) return { ok: false as const };
  const joinedFrom = query.joinedFrom ? kstDayStart(query.joinedFrom) : null;
  const joinedToStart = query.joinedTo ? kstDayStart(query.joinedTo) : null;
  if ((query.joinedFrom && !joinedFrom) || (query.joinedTo && !joinedToStart)) return { ok: false as const };
  const joinedTo = joinedToStart ? new Date(joinedToStart.getTime() + DAY_MS) : null;
  if (joinedFrom && joinedTo && joinedFrom >= joinedTo) return { ok: false as const };

  const pii = canViewCustomerPii(ctx);
  // 이름·휴대폰 끝자리로 찾는 것은 개인정보 권한이 있을 때만(없으면 조용히 닉네임만 찾지 않고 요청을 거절한다)
  const qType = query.qType || null;
  if (q && (qType === "name" || qType === "phoneLast4") && !pii) return { ok: false as const };
  if (q && qType === "phoneLast4" && !/^\d{4}$/.test(q)) return { ok: false as const };
  const searchesPii = q !== "" && pii && qType !== "nickname";
  const and: Prisma.BuyerMemberWhereInput[] = [{ sellerId: ctx.sellerId, deletedAt: null, status: { in: [...LIST_STATUSES] } }];
  if (status === "ACTIVE" || status === "DORMANT") and.push({ status });
  if (status === "RESTRICTED") and.push(restrictedWhere(now));
  if (status === "NORMAL") and.push({ status: "ACTIVE" }, { NOT: restrictedWhere(now) });
  if (query.gradeId) and.push({ gradeId: query.gradeId });
  if (gradeIds.length) and.push({ gradeId: { in: gradeIds } });
  if (joinedFrom) and.push({ createdAt: { gte: joinedFrom } });
  if (joinedTo) and.push({ createdAt: { lt: joinedTo } });
  if (query.lastOrder === "30d" || query.lastOrder === "90d") {
    and.push({ orders: { some: { legalHoldAt: null, createdAt: { gte: new Date(now.getTime() - (query.lastOrder === "30d" ? 30 : 90) * DAY_MS) } } } });
  }
  if (query.lastOrder === "over90d") and.push({ orders: { none: { legalHoldAt: null, createdAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } } } });
  if (marketing) and.push({ marketingConsentAt: { not: null } });
  if (hasBalance) and.push({ rewardBalances: { some: { balance: { gt: 0 } } } });
  if (hasMemo) and.push({ memo: { isNot: null } });
  if (q) {
    const or: Prisma.BuyerMemberWhereInput[] = [];
    if (!qType || qType === "nickname") or.push({ broadcastNickname: { contains: q, mode: "insensitive" } });
    if (searchesPii) {
      if (!qType || qType === "name") or.push({ name: { contains: q, mode: "insensitive" } });
      if ((!qType || qType === "phoneLast4") && /^\d{4}$/.test(q)) or.push({ phone: { endsWith: q } });
    }
    and.push({ OR: or });
  }

  let page: MemberRow[];
  let nextCursor: string | null;
  let agg: Aggregates;
  if (byJoined) {
    if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
    const rows = await db.buyerMember.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: LIST_SELECT });
    page = rows.slice(0, take);
    const last = page[page.length - 1];
    nextCursor = rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null;
    agg = await memberAggregates(db, ctx.sellerId, page.map((m) => m.id));
  } else {
    // 집계값 정렬: 조건에 맞는 회원 전체를 정렬해 위치로 자른다(쇼핑몰 회원 수만큼, 페이지마다 같은 기준으로 다시 센다).
    const all = await db.buyerMember.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: LIST_SELECT });
    const full = await memberAggregates(db, ctx.sellerId);
    const key = (id: string) => (sort === "lastOrder" ? (full.lastOrderAt.get(id)?.getTime() ?? 0) : sort === "spent" ? (full.paid.get(id) ?? 0) : (full.balance.get(id) ?? 0));
    // Array.sort는 안정 정렬이라 값이 같으면 위 가입 시각 내림차순이 유지된다
    const sorted = [...all].sort((x, y) => key(y.id) - key(x.id));
    const start = offset ?? 0;
    page = sorted.slice(start, start + take);
    nextCursor = sorted.length > start + take ? String(start + take) : null;
    agg = full;
  }
  const numbers = await joinNumbers(db, ctx.sellerId, page.map((m) => m.id));
  const restricted = page.length
    ? new Set((await db.buyerPurchaseRestriction.findMany({ where: { sellerId: ctx.sellerId, buyerMemberId: { in: page.map((m) => m.id) }, liftedAt: null, endsAt: { gt: now } }, select: { buyerMemberId: true } })).map((r) => r.buyerMemberId))
    : new Set<string>();
  // 이름·휴대폰을 내보냈거나 그것으로 찾았으면 열람 기록. 검색어는 남기지 않고 돌려준 회원 id·건수만 남긴다.
  // 개인정보로 찾았으면 결과가 0건이어도 남긴다(일치 여부도 개인정보 확인이다, #209 Codex).
  if (searchesPii || (pii && page.length > 0)) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "MemberList",
      reason: searchesPii ? "member_list_search" : "member_list",
      after: { memberIds: page.map((m) => m.id), count: page.length },
    });
  }
  return {
    ok: true as const,
    members: page.map((m) => ({
      ...view(m, pii),
      number: numbers.get(m.id) ?? 0,
      orderCount: agg.count.get(m.id) ?? 0,
      totalPaid: agg.paid.get(m.id) ?? 0,
      rewardBalance: agg.balance.get(m.id) ?? 0,
      lastOrderAt: agg.lastOrderAt.get(m.id) ?? null,
      restricted: restricted.has(m.id),
    })),
    nextCursor,
  };
}

// 회원 목록 위 요약 6칸(MEMBER_POINTS, 탈퇴 회원 제외, 이번 달은 KST 기준).
// total 전체 회원 · newThisMonth 이번 달 신규 · purchasedThisMonth 이번 달 결제 회원 · gold·vip 등급(시스템 키) 회원 수 · restricted 구매 제한 중 · marketingConsent 혜택·소식 동의.
export async function sellerMemberSummary(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const kst = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);
  const monthStart = kstDayStart(`${kst}-01`)!;
  const base = { sellerId: ctx.sellerId, deletedAt: null, status: { in: [...LIST_STATUSES] } } satisfies Prisma.BuyerMemberWhereInput;
  const [total, newThisMonth, gold, vip, restricted, marketingConsent, purchased] = await Promise.all([
    db.buyerMember.count({ where: base }),
    db.buyerMember.count({ where: { ...base, createdAt: { gte: monthStart } } }),
    db.buyerMember.count({ where: { ...base, grade: { systemKey: "GOLD" } } }),
    db.buyerMember.count({ where: { ...base, grade: { systemKey: "VIP" } } }),
    db.buyerMember.count({ where: { ...base, ...restrictedWhere(now) } }),
    db.buyerMember.count({ where: { ...base, marketingConsentAt: { not: null } } }),
    db.order.groupBy({ by: ["buyerMemberId"], where: { sellerId: ctx.sellerId, legalHoldAt: null, paidAt: { gte: monthStart }, buyerMember: { deletedAt: null } } }),
  ]);
  return { total, newThisMonth, purchasedThisMonth: purchased.length, gold, vip, restricted, marketingConsent };
}

// 잔액 조정 대상만 확인한다. 개인정보·주문 집계와 개인정보 열람 감사를 만들지 않는다.
export async function getSellerMemberSummary(db: PrismaClient, ctx: TenantContext, memberId: string) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  if (!UUID_RE.test(memberId)) throw notFound();
  const member = await db.buyerMember.findFirst({ where: { id: memberId, sellerId: ctx.sellerId, deletedAt: null }, select: { id: true, broadcastNickname: true } });
  if (!member) throw notFound();
  const balance = await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: ctx.sellerId, buyerMemberId: member.id } }, select: { balance: true } });
  return { ...member, rewardBalance: balance?.balance ?? 0 };
}

// 회원 상세: 목록 항목 + 주문 수·누적 결제(결제된 주문 금액 − 환불액)·적립금 잔액. 탈퇴·다른 쇼핑몰 회원은 404.
export async function getSellerMember(db: PrismaClient, ctx: TenantContext, memberId: string) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  if (!UUID_RE.test(memberId)) throw notFound();
  const m = await db.buyerMember.findFirst({ where: { id: memberId, sellerId: ctx.sellerId, deletedAt: null }, select: LIST_SELECT });
  if (!m) throw notFound();
  // 법정 보관으로 분리한 주문(legalHoldAt)은 일반 조회에서 없는 주문이다(orders/read.ts)
  const orders = { sellerId: ctx.sellerId, buyerMemberId: m.id, legalHoldAt: null } as const;
  const [orderCount, paid, balance] = await Promise.all([
    db.order.count({ where: orders }),
    db.order.aggregate({ where: { ...orders, paidAt: { not: null } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: ctx.sellerId, buyerMemberId: m.id } }, select: { balance: true } }),
  ]);
  const pii = canViewCustomerPii(ctx);
  if (pii) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "BuyerMember",
      targetId: m.id,
    });
  }
  return {
    ...view(m, pii),
    orderCount,
    totalPaid: (paid._sum.totalAmount ?? 0) - (paid._sum.refundAmount ?? 0),
    rewardBalance: balance?.balance ?? 0,
  };
}
