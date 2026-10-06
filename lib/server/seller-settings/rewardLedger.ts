import type { Prisma, PrismaClient, RewardEarnTiming, RewardLedgerStatus, RewardLedgerType } from "@prisma/client";
import { decodeCursor, encodeCursor } from "../orders/read";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { orderNoLabel, parseOrderNoLabel } from "../orders/orderNoLabel";

// 적립금 지급·회수 원장 조회(SA-032, MEMBER_POINTS). 조회만 하고 지급·회수를 실행하지 않는다.
// 줄마다 kind(화면 「유형」): EARN_DELIVERY 배송 완료 적립 · EARN_PAYMENT 결제 적립(주문의 지급 시점 스냅숏) · REVIEW 리뷰 적립 · REVOKE 회수 ·
// ADJUST_GRANT 수동 지급 · ADJUST_REVOKE 수동 회수 · BONUS 인기 카드 보너스 · USE 사용 · EXPIRE 소멸. kind 쿼리로 거를 수 있다.
// balanceAfter(「잔액(후)」): 그 회원의 성공(SUCCEEDED) 원장을 처리 시각 순으로 더한 그 줄까지의 잔액. 성공이 아닌 줄은 null(잔액에 반영 전·안 됨).
// q: 방송 닉네임 부분 일치 또는 주문번호(「20261005-0004」 형식이나 숫자 순번). order에는 첫 상품 이름과 품목 수를 함께 준다.
// 항상 ctx.sellerId 범위만 본다. 탈퇴 회원의 줄은 닉네임이 「탈퇴회원-…」으로 바뀐 채 남는다(buyers/withdraw.ts).
export const REWARD_LEDGER_PAGE_DEFAULT = 50;
export const REWARD_LEDGER_PAGE_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly RewardLedgerStatus[] = ["PENDING", "SUCCEEDED", "FAILED"];

// from·to: 생성일(한국 시간 YYYY-MM-DD, 끝 날짜 포함)로 거른다. 둘 다 없으면 전체 기간. 하나만 줘도 된다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstDayStart = (d: string) => new Date(`${d}T00:00:00+09:00`);
export const LEDGER_KINDS = ["EARN_DELIVERY", "EARN_PAYMENT", "REVIEW", "REVOKE", "ADJUST_GRANT", "ADJUST_REVOKE", "BONUS", "USE", "EXPIRE"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export type RewardLedgerQuery = { status?: string | null; kind?: string | null; q?: string | null; memberId?: string | null; cursor?: string | null; limit?: string | null; from?: string | null; to?: string | null };

type KindRow = { type: RewardLedgerType; amount: number; idempotencyKey: string; order: { rewardEarnTiming: RewardEarnTiming | null } | null };
export function ledgerKind(r: KindRow): LedgerKind {
  switch (r.type) {
    case "EARN":
      if (r.idempotencyKey.startsWith("review_reward:")) return "REVIEW";
      return r.order?.rewardEarnTiming === "ON_PAYMENT" ? "EARN_PAYMENT" : "EARN_DELIVERY";
    case "REVOKE":
      return "REVOKE";
    case "ADJUST":
      return r.amount < 0 ? "ADJUST_REVOKE" : "ADJUST_GRANT";
    case "RANKING_BONUS":
      return "BONUS";
    case "USE":
      return "USE";
    default:
      return "EXPIRE";
  }
}

function kindWhere(kind: LedgerKind): Prisma.RewardLedgerWhereInput {
  switch (kind) {
    case "EARN_DELIVERY":
      return { type: "EARN", NOT: { idempotencyKey: { startsWith: "review_reward:" } }, order: { is: { rewardEarnTiming: { not: "ON_PAYMENT" } } } };
    case "EARN_PAYMENT":
      return { type: "EARN", NOT: { idempotencyKey: { startsWith: "review_reward:" } }, order: { is: { rewardEarnTiming: "ON_PAYMENT" } } };
    case "REVIEW":
      return { type: "EARN", idempotencyKey: { startsWith: "review_reward:" } };
    case "REVOKE":
      return { type: "REVOKE" };
    case "ADJUST_GRANT":
      return { type: "ADJUST", amount: { gt: 0 } };
    case "ADJUST_REVOKE":
      return { type: "ADJUST", amount: { lt: 0 } };
    case "BONUS":
      return { type: "RANKING_BONUS" };
    case "USE":
      return { type: "USE" };
    default:
      return { type: "EXPIRE" };
  }
}

const SELECT = {
  id: true,
  type: true,
  amount: true,
  status: true,
  testMode: true,
  failureReason: true,
  reason: true,
  idempotencyKey: true,
  createdAt: true,
  processedAt: true,
  buyerMember: { select: { id: true, broadcastNickname: true } },
  order: { select: { id: true, orderNo: true, createdAt: true, rewardEarnTiming: true } },
} as const satisfies Prisma.RewardLedgerSelect;

// 생성 시각 내림차순, (createdAt, id) 커서 페이지. 잘못된 값이면 { ok: false }.
export async function listRewardLedger(db: PrismaClient, ctx: TenantContext, query: RewardLedgerQuery) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? REWARD_LEDGER_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, REWARD_LEDGER_PAGE_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  if (query.status && !STATUSES.includes(query.status as RewardLedgerStatus)) return { ok: false as const };
  if (query.memberId && !UUID_RE.test(query.memberId)) return { ok: false as const };
  if (query.kind && !LEDGER_KINDS.includes(query.kind as LedgerKind)) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };

  for (const d of [query.from, query.to]) {
    if (d && (!DATE_RE.test(d) || Number.isNaN(kstDayStart(d).getTime()))) return { ok: false as const };
  }
  if (query.from && query.to && query.from > query.to) return { ok: false as const };

  const and: Prisma.RewardLedgerWhereInput[] = [{ sellerId: ctx.sellerId }];
  if (query.from) and.push({ createdAt: { gte: kstDayStart(query.from) } });
  if (query.to) and.push({ createdAt: { lt: new Date(kstDayStart(query.to).getTime() + 86_400_000) } });
  if (query.status) and.push({ status: query.status as RewardLedgerStatus });
  if (query.memberId) and.push({ buyerMemberId: query.memberId });
  if (query.kind) and.push(kindWhere(query.kind as LedgerKind));
  if (q) {
    const or: Prisma.RewardLedgerWhereInput[] = [{ buyerMember: { broadcastNickname: { contains: q, mode: "insensitive" } } }];
    if (/^\d{1,9}$/.test(q)) or.push({ order: { is: { orderNo: Number(q) } } });
    const label = parseOrderNoLabel(q);
    if (label) or.push({ order: { is: { orderNo: label.orderNo, createdAt: { gte: label.from, lt: label.to } } } });
    and.push({ OR: or });
  }
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });

  const rows = await db.rewardLedger.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: SELECT });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  const ok = page.filter((r) => r.status === "SUCCEEDED").map((r) => r.id);
  const after = ok.length
    ? await db.$queryRaw<{ id: string; after: number }[]>`
        SELECT l."id", (SELECT coalesce(sum(x."amount"), 0)::int FROM "RewardLedger" x
          WHERE x."sellerId" = l."sellerId" AND x."buyerMemberId" = l."buyerMemberId" AND x."status" = 'SUCCEEDED'
            AND (coalesce(x."processedAt", x."createdAt"), x."id") <= (coalesce(l."processedAt", l."createdAt"), l."id")) AS "after"
        FROM "RewardLedger" l WHERE l."sellerId" = ${ctx.sellerId}::uuid AND l."id" = ANY(${ok}::uuid[])`
    : [];
  const balanceAfter = new Map(after.map((a) => [a.id, a.after]));
  const orderIds = [...new Set(page.flatMap((r) => (r.order ? [r.order.id] : [])))];
  const items = orderIds.length
    ? await db.orderItem.findMany({ where: { sellerId: ctx.sellerId, orderId: { in: orderIds } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { orderId: true, productNameSnapshot: true } })
    : [];
  const summary = new Map<string, { firstProductName: string; itemCount: number }>();
  for (const i of items) {
    const cur = summary.get(i.orderId);
    if (cur) cur.itemCount += 1;
    else summary.set(i.orderId, { firstProductName: i.productNameSnapshot, itemCount: 1 });
  }
  return {
    ok: true as const,
    entries: page.map((r) => ({
      id: r.id,
      member: { id: r.buyerMember.id, broadcastNickname: r.buyerMember.broadcastNickname },
      type: r.type,
      kind: ledgerKind(r),
      amount: r.amount,
      status: r.status,
      failureReason: r.failureReason,
      reason: r.reason,
      balanceAfter: r.status === "SUCCEEDED" ? (balanceAfter.get(r.id) ?? null) : null,
      order: r.order ? { id: r.order.id, orderNo: r.order.orderNo, orderNoLabel: orderNoLabel(r.order.createdAt, r.order.orderNo), createdAt: r.order.createdAt, ...(summary.get(r.order.id) ?? { firstProductName: null, itemCount: 0 }) } : null,
      testMode: r.testMode,
      createdAt: r.createdAt,
      processedAt: r.processedAt,
    })),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// 원장 요약 카드(SA-032). 쇼핑몰 전체 기준(기간 필터와 상관없음), 「오늘」은 한국 시간 0시부터.
// pending: 대기(PENDING) 전체의 건수와 지급 예정(양수) 합계 · todaySucceeded: 오늘 성공 처리된 지급(양수) 건수·합계 · failed: 실패 중 처리할 수 있는 줄
// (탈퇴 회원으로 닫힌 줄은 뺀다) 건수와 절대값 합계 · todayRevoked: 오늘 성공한 회수(REVOKE) 건수·절대값 합계 · issuedBalance: 탈퇴하지 않은 회원의 잔액 합계(총 발행 잔액).
export async function rewardLedgerSummary(db: PrismaClient, ctx: TenantContext, now: Date = new Date()) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const sellerId = ctx.sellerId;
  const dayStart = new Date(Math.floor((now.getTime() + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000);
  const [pending, succeeded, failed, revoked, balance] = await Promise.all([
    db.rewardLedger.aggregate({ where: { sellerId, status: "PENDING" }, _count: { _all: true } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "SUCCEEDED", amount: { gt: 0 }, processedAt: { gte: dayStart } }, _count: { _all: true }, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "FAILED", NOT: { failureReason: "member_withdrawn" } }, _count: { _all: true }, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "SUCCEEDED", type: "REVOKE", processedAt: { gte: dayStart } }, _count: { _all: true }, _sum: { amount: true } }),
    db.rewardBalance.aggregate({ where: { sellerId, buyerMember: { deletedAt: null } }, _sum: { balance: true } }),
  ]);
  const pendingGrants = await db.rewardLedger.aggregate({ where: { sellerId, status: "PENDING", amount: { gt: 0 } }, _sum: { amount: true } });
  return {
    pending: { count: pending._count._all, amount: pendingGrants._sum.amount ?? 0 },
    todaySucceeded: { count: succeeded._count._all, amount: succeeded._sum.amount ?? 0 },
    failed: { count: failed._count._all, amount: Math.abs(failed._sum.amount ?? 0) },
    todayRevoked: { count: revoked._count._all, amount: Math.abs(revoked._sum.amount ?? 0) },
    issuedBalance: balance._sum.balance ?? 0,
  };
}
