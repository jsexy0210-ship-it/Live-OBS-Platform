import type { PrismaClient } from "@prisma/client";
import { decodeCursor, encodeCursor } from "../orders/read";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { RewardRates } from "./earn";

// 실제 지급 켜기 화면(SA-034, MEMBER_POINTS 조회): 켜기 전 확인(지급 대기 건수·금액), 켜기 조건 표, 켜기·끄기 전환 이력.
// 켜기 조건(MASTER 지시로 서버는 표시용 값을 준다. 켜기를 막는 것은 아니다 — 막을지는 결정 대기):
// - policy: 적립 정책 설정 완료 = 저장된 정책이 있고 적립률이 하나라도 0보다 큼
// - noRecentFailures: 최근 7일 지급 실패 0건 = 최근 7일에 실패로 남은 줄(탈퇴 회원으로 닫힌 줄 제외)이 없음. 있으면 원장에서 재시도.
// - subscription: 구독 상태 이용 중 = 이 화면은 이용 중인 쇼핑몰만 열려 항상 충족.
// (정본의 「PG 연결 정상」 줄은 파트너스별 PG 연결이 폐지되어(2026-10-05) 서버 조건이 없다.)
const DAY_MS = 86_400_000;

export async function readLivePayoutConditions(db: PrismaClient, ctx: TenantContext, now: Date = new Date()) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const sellerId = ctx.sellerId;
  const [policy, pending, pendingGrants, failed] = await Promise.all([
    db.rewardPolicy.findUnique({ where: { sellerId }, select: { rates: true } }),
    db.rewardLedger.count({ where: { sellerId, status: "PENDING" } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "PENDING", amount: { gt: 0 } }, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "FAILED", NOT: { failureReason: "member_withdrawn" }, processedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  const rates = (policy?.rates && typeof policy.rates === "object" ? policy.rates : {}) as RewardRates;
  const hasRate = Object.values(rates).some((r) => (r.card ?? 0) > 0 || (r.bankTransfer ?? 0) > 0);
  const failures = failed._count._all;
  const conditions = [
    { key: "policy" as const, met: !!policy && hasRate, failedCount: null as number | null },
    { key: "noRecentFailures" as const, met: failures === 0, failedCount: failures },
    { key: "subscription" as const, met: true, failedCount: null as number | null },
  ];
  return {
    pending: { count: pending, amount: pendingGrants._sum.amount ?? 0 },
    recentFailed: { count: failures, amount: Math.abs(failed._sum.amount ?? 0) },
    conditions,
    canEnable: conditions.every((c) => c.met),
  };
}

// 전환 이력: 최근 순. 켠 줄에는 그때 일괄 지급한 건수·금액(settled)을 함께 준다(그 전환부터 다음 전환 전까지 「켜기·이어서」로 처리한 합계).
export const LIVE_HISTORY_DEFAULT = 20;
export const LIVE_HISTORY_MAX = 100;
export async function listLivePayoutHistory(db: PrismaClient, ctx: TenantContext, query: { cursor?: string | null; limit?: string | null }) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? LIVE_HISTORY_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, LIVE_HISTORY_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const rows = await db.auditLog.findMany({
    where: { sellerId: ctx.sellerId, action: "reward_policy.live_payout", ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: { id: true, actorType: true, actorId: true, after: true, createdAt: true },
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  const userIds = [...new Set(page.filter((r) => r.actorType === "SELLER_USER" && r.actorId).map((r) => r.actorId!))];
  const users = userIds.length ? await db.sellerUser.findMany({ where: { sellerId: ctx.sellerId, id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  // 일괄 지급 합계: 이 쪽 전환 시각 이후 ~ 바로 다음(더 늦은) 전환 전까지
  const oldest = last?.createdAt;
  const settles = oldest
    ? await db.auditLog.findMany({ where: { sellerId: ctx.sellerId, action: "reward.settle", createdAt: { gte: oldest } }, select: { after: true, createdAt: true } })
    : [];
  const newerToggle = await db.auditLog.findMany({ where: { sellerId: ctx.sellerId, action: "reward_policy.live_payout", createdAt: { gte: oldest ?? new Date(0) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, createdAt: true } });
  const nextAt = new Map(newerToggle.map((t, i) => [t.id, newerToggle[i + 1]?.createdAt ?? null]));
  return {
    ok: true as const,
    history: page.map((r) => {
      const enabled = ((r.after ?? {}) as { enabled?: boolean }).enabled === true;
      const end = nextAt.get(r.id) ?? null;
      let count = 0;
      let amount = 0;
      if (enabled) {
        for (const s of settles) {
          const a = (s.after ?? {}) as { trigger?: string; settled?: number; settledAmount?: number };
          if ((a.trigger === "live_on" || a.trigger === "continue") && s.createdAt >= r.createdAt && (!end || s.createdAt < end)) {
            count += a.settled ?? 0;
            amount += a.settledAmount ?? 0;
          }
        }
      }
      return { id: r.id, at: r.createdAt, enabled, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null, settled: enabled ? { count, amount } : null };
    }),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
