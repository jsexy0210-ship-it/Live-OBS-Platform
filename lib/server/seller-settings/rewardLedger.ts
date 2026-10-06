import type { Prisma, PrismaClient, RewardLedgerStatus } from "@prisma/client";
import { decodeCursor, encodeCursor } from "../orders/read";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { orderNoLabel } from "../orders/orderNoLabel";

// 적립금 지급·회수 원장 조회(SA-032, MEMBER_POINTS). 조회만 하고 지급·회수를 실행하지 않는다.
// 항상 ctx.sellerId 범위만 본다. 탈퇴 회원의 줄은 닉네임이 「탈퇴회원-…」으로 바뀐 채 남는다(buyers/withdraw.ts).
export const REWARD_LEDGER_PAGE_DEFAULT = 50;
export const REWARD_LEDGER_PAGE_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly RewardLedgerStatus[] = ["PENDING", "SUCCEEDED", "FAILED"];

// from·to: 생성일(한국 시간 YYYY-MM-DD, 끝 날짜 포함)로 거른다. 둘 다 없으면 전체 기간. 하나만 줘도 된다.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstDayStart = (d: string) => new Date(`${d}T00:00:00+09:00`);
export type RewardLedgerQuery = { status?: string | null; memberId?: string | null; cursor?: string | null; limit?: string | null; from?: string | null; to?: string | null };

const SELECT = {
  id: true,
  type: true,
  amount: true,
  status: true,
  testMode: true,
  failureReason: true,
  createdAt: true,
  processedAt: true,
  buyerMember: { select: { id: true, broadcastNickname: true } },
  order: { select: { id: true, orderNo: true, createdAt: true } },
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

  for (const d of [query.from, query.to]) {
    if (d && (!DATE_RE.test(d) || Number.isNaN(kstDayStart(d).getTime()))) return { ok: false as const };
  }
  if (query.from && query.to && query.from > query.to) return { ok: false as const };

  const and: Prisma.RewardLedgerWhereInput[] = [{ sellerId: ctx.sellerId }];
  if (query.from) and.push({ createdAt: { gte: kstDayStart(query.from) } });
  if (query.to) and.push({ createdAt: { lt: new Date(kstDayStart(query.to).getTime() + 86_400_000) } });
  if (query.status) and.push({ status: query.status as RewardLedgerStatus });
  if (query.memberId) and.push({ buyerMemberId: query.memberId });
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });

  const rows = await db.rewardLedger.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: SELECT });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    entries: page.map((r) => ({
      id: r.id,
      member: { id: r.buyerMember.id, broadcastNickname: r.buyerMember.broadcastNickname },
      type: r.type,
      amount: r.amount,
      status: r.status,
      failureReason: r.failureReason,
      order: r.order ? { id: r.order.id, orderNo: r.order.orderNo, orderNoLabel: orderNoLabel(r.order.createdAt, r.order.orderNo) } : null,
      testMode: r.testMode,
      createdAt: r.createdAt,
      processedAt: r.processedAt,
    })),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
