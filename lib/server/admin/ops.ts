import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { OVERLAY_ONLINE_MS } from "../overlay/token";
import { kstDate, parseStatsRange } from "../stats/range";
import { RATE_MAX } from "../rewards/policyAdmin";

// 마스터 관리자 운영 현황(조회만, platform.read): 방송 중 파트너스 MA-041 · 파트너스별 주문·오버레이 접속 MA-042 ·
// 적립금 실지급 켜진 파트너스 MA-043. 쇼핑몰 이름·주소(slug)·숫자만 주고 구매자·직원 개인정보는 넣지 않는다.
// - 오버레이 접속: 지금 쓰는 오버레이 주소(폐기 안 된 토큰)의 마지막 접속 시각. 2분 안이면 online.
// - 오늘: KST 0시부터. 결제 금액은 환불액을 뺀다(대시보드 MA-001과 같은 기준).
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const ACTIVITY_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}
const todayStartOf = (now: Date) => new Date(Math.floor((now.getTime() + KST_MS) / DAY_MS) * DAY_MS - KST_MS);

async function overlaySeen(db: PrismaClient, sellerIds: string[], now: Date) {
  const tokens = await db.overlayToken.findMany({ where: { sellerId: { in: sellerIds }, revokedAt: null }, select: { sellerId: true, lastSeenAt: true } });
  const map = new Map<string, { connected: boolean; lastSeenAt: Date | null }>();
  for (const t of tokens) {
    map.set(t.sellerId, { connected: !!t.lastSeenAt && now.getTime() - t.lastSeenAt.getTime() <= OVERLAY_ONLINE_MS, lastSeenAt: t.lastSeenAt });
  }
  return (sellerId: string) => ({ hasUrl: map.has(sellerId), ...(map.get(sellerId) ?? { connected: false, lastSeenAt: null }) });
}

// MA-041: 지금 방송 중(LIVE)인 방송. 최근에 시작한 순, 200개까지.
export async function listLiveBroadcasts(db: PrismaClient, admin: AdminSessionContext) {
  requireRead(admin);
  const now = await dbNow(db);
  const rateFrom = new Date(now.getTime() - 60_000);
  const sessions = await db.broadcastSession.findMany({
    where: { status: "LIVE" },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: 200,
    select: { id: true, title: true, startedAt: true, sellerId: true, layoutAspect: true, seller: { select: { shopName: true, slug: true, status: true } } },
  });
  const ids = sessions.map((s) => s.id);
  const sellerIds = [...new Set(sessions.map((s) => s.sellerId))];
  const [byStatus, orders, failed, approved, recentOrders] = await Promise.all([
    db.queueItem.groupBy({ by: ["broadcastSessionId", "status"], where: { broadcastSessionId: { in: ids } }, _count: { _all: true } }),
    db.queueItem.groupBy({ by: ["broadcastSessionId", "orderId"], where: { broadcastSessionId: { in: ids }, status: { not: "CANCELLED" } } }),
    // 결제대행사 상태: 최근 24시간 결제 실패가 있고 그 뒤 성공이 없으면 「결제 연결 오류」(MA-031 게이트웨이 상태와 같은 기준)
    db.payment.groupBy({ by: ["sellerId"], where: { sellerId: { in: sellerIds }, status: "FAILED", updatedAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }, _count: { _all: true }, _max: { updatedAt: true } }),
    db.payment.groupBy({ by: ["sellerId"], where: { sellerId: { in: sellerIds }, approvedAt: { not: null } }, _max: { approvedAt: true } }),
    // 내부 주문 생성 건수: 같은 판매자의 LIVE 방송 시작 이후이면서 최근 60초 [from, at).
    // 모든 LIVE 방송을 집계해 표시 한도 200건과 분리한다. 겹치는 방송도 전체 주문은 한 번만 센다.
    // Order의 기존 sellerId/createdAt 인덱스로 범위를 좁히며 개인정보·주문 행은 반환하지 않는다.
    db.$queryRaw<{ broadcastId: string | null; count: number }[]>`
      SELECT b.id AS "broadcastId", count(DISTINCT o.id)::int AS count
      FROM "BroadcastSession" b
      JOIN "Order" o ON o."sellerId" = b."sellerId"
        AND o."createdAt" >= ${rateFrom} AND o."createdAt" >= b."startedAt" AND o."createdAt" < ${now}
      WHERE b.status = 'LIVE'
      GROUP BY GROUPING SETS ((b.id), ())`,
  ]);
  const seen = await overlaySeen(db, sellerIds, now);
  const paymentError = (sellerId: string) => {
    const f = failed.find((r) => r.sellerId === sellerId);
    if (!f?._max.updatedAt) return false;
    const ok = approved.find((r) => r.sellerId === sellerId)?._max.approvedAt;
    return !ok || f._max.updatedAt > ok;
  };
  const items = sessions.map((s) => {
    const count = (status: string) => byStatus.find((r) => r.broadcastSessionId === s.id && r.status === status)?._count._all ?? 0;
    return {
      sellerId: s.sellerId,
      shopName: s.seller.shopName,
      slug: s.seller.slug,
      sellerStatus: s.seller.status,
      broadcastId: s.id,
      title: s.title,
      startedAt: s.startedAt,
      queue: { waiting: count("WAITING"), opening: count("OPENING"), done: count("DONE"), cancelled: count("CANCELLED") },
      orders: orders.filter((o) => o.broadcastSessionId === s.id).length,
      ordersLast60Seconds: recentOrders.find((r) => r.broadcastId === s.id)?.count ?? 0,
      overlay: seen(s.sellerId),
      layoutAspect: s.layoutAspect,
      paymentError: paymentError(s.sellerId),
    };
  });
  return { at: now, items, orderRate: {
    source: "INTERNAL_ORDER_CREATED_DURING_LIVE_SESSION" as const,
    association: "SELLER_AND_TIME_WINDOW" as const, externalOrders: "NOT_MEASURED" as const,
    scope: "ALL_LIVE_SESSIONS" as const, windowSeconds: 60 as const, from: rateFrom, to: now,
    total: recentOrders.find((r) => r.broadcastId === null)?.count ?? 0,
  } };
}

// MA-042: 승인된 파트너스(이용 중·정지)별 오늘 주문·결제와 방송·오버레이 접속. 가입 순 최신 50곳씩 커서.
export async function listSellerActivity(db: PrismaClient, admin: AdminSessionContext, q: { cursor?: string | null; period?: string | null; asOf?: string | null }) {
  requireRead(admin);
  const period = q.period ?? "today";
  if (!["today", "7d", "30d"].includes(period)) return { ok: false as const, reason: "invalid_period" as const };
  const observedAt = await dbNow(db);
  const now = q.asOf == null ? observedAt : new Date(q.asOf);
  if (Number.isNaN(now.getTime()) || (q.asOf != null && (q.asOf.length !== 24 || now.toISOString() !== q.asOf)) || now > observedAt) return { ok: false as const, reason: "invalid_as_of" as const };
  const todayStart = todayStartOf(now);
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 1;
  const range = parseStatsRange({ from: kstDate(new Date(todayStart.getTime() - (days - 1) * DAY_MS)), to: kstDate(now) });
  if (!range) return { ok: false as const, reason: "invalid_as_of" as const };
  let after: Prisma.SellerWhereInput = {};
  if (q.cursor) {
    const i = q.cursor.lastIndexOf("_");
    const at = new Date(q.cursor.slice(0, i));
    const id = q.cursor.slice(i + 1);
    if (i <= 0 || Number.isNaN(at.getTime()) || !UUID.test(id)) return { ok: false as const, reason: "invalid_cursor" as const };
    after = { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
  }
  const rows = await db.seller.findMany({
    where: { status: { in: ["ACTIVE", "SUSPENDED"] }, ...after },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ACTIVITY_PAGE_SIZE + 1,
    select: { id: true, shopName: true, slug: true, status: true, createdAt: true },
  });
  const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const ids = page.map((s) => s.id);
  const [activity, live] = await Promise.all([
    db.$queryRaw<{ sellerId: string | null; created: number; paid: number; paidAmount: bigint; todayCreated: number; todayPaid: number; todayPaidAmount: bigint }[]>`
      SELECT o."sellerId", count(*) FILTER (WHERE o."createdAt" >= ${range.start} AND o."createdAt" < ${now})::int AS created,
        count(*) FILTER (WHERE o."paidAt" >= ${range.start} AND o."paidAt" < ${now})::int AS paid,
        coalesce(sum(o."totalAmount"::bigint - coalesce(o."refundAmount", 0)) FILTER (WHERE o."paidAt" >= ${range.start} AND o."paidAt" < ${now}), 0)::bigint AS "paidAmount",
        count(*) FILTER (WHERE o."createdAt" >= ${todayStart} AND o."createdAt" < ${now})::int AS "todayCreated",
        count(*) FILTER (WHERE o."paidAt" >= ${todayStart} AND o."paidAt" < ${now})::int AS "todayPaid",
        coalesce(sum(o."totalAmount"::bigint - coalesce(o."refundAmount", 0)) FILTER (WHERE o."paidAt" >= ${todayStart} AND o."paidAt" < ${now}), 0)::bigint AS "todayPaidAmount"
      FROM "Order" o JOIN "Seller" s ON s.id = o."sellerId"
      WHERE s.status IN ('ACTIVE', 'SUSPENDED') AND
        ((o."createdAt" >= ${range.start} AND o."createdAt" < ${now}) OR (o."paidAt" >= ${range.start} AND o."paidAt" < ${now}))
      GROUP BY GROUPING SETS ((o."sellerId"), ())
      HAVING GROUPING(o."sellerId") = 1 OR o."sellerId" = ANY(${ids}::uuid[])`,
    db.broadcastSession.findMany({ where: { sellerId: { in: ids }, status: "LIVE" }, select: { sellerId: true, startedAt: true } }),
  ]);
  const seen = await overlaySeen(db, ids, observedAt);
  const metrics = (r: (typeof activity)[number] | undefined) => ({ created: r?.created ?? 0, paid: r?.paid ?? 0, paidAmount: Number(r?.paidAmount ?? 0) });
  const items = page.map((s) => {
    const p = activity.find((r) => r.sellerId === s.id);
    const l = live.find((r) => r.sellerId === s.id);
    return {
      sellerId: s.id,
      shopName: s.shopName,
      slug: s.slug,
      status: s.status,
      ordersToday: {
        created: p?.todayCreated ?? 0,
        paid: p?.todayPaid ?? 0,
        paidAmount: Number(p?.todayPaidAmount ?? 0),
      },
      ordersPeriod: metrics(p),
      live: l ? { startedAt: l.startedAt } : null,
      overlay: seen(s.id),
    };
  });
  const last = page[page.length - 1];
  return { ok: true as const, at: now, observedAt, todayStart, items,
    period: { key: period, days, from: range.from, to: range.to, start: range.start, end: now, timezone: "Asia/Seoul" as const, snapshot: "TIME_BOUNDARY_ONLY_CURRENT_STATE" as const },
    sources: { created: "INTERNAL_ORDER_CREATED_AT", paid: "INTERNAL_ORDER_PAID_AT_CURRENT_REFUND_NET", externalOrders: "NOT_MEASURED" } as const,
    summary: { scope: "CURRENT_ACTIVE_AND_SUSPENDED_SELLERS" as const, ...metrics(activity.find((r) => r.sellerId === null)) },
    nextCursor: rows.length > ACTIVITY_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null };
}

// MA-043: 적립금 실지급을 켠 파트너스. 켠 시각 최근 순. 남은 적립금 합계·적립금이 남은 회원 수(개인 단위는 주지 않음).
export async function listLivePayoutSellers(db: PrismaClient, admin: AdminSessionContext) {
  requireRead(admin);
  const now = await dbNow(db);
  const todayStart = todayStartOf(now);
  const monthStart = parseStatsRange({ from: `${kstDate(now).slice(0, 7)}-01`, to: kstDate(now) })!.start;
  const manualSince = new Date(now.getTime() - 30 * DAY_MS);
  const policies = await db.rewardPolicy.findMany({
    where: { livePayoutEnabled: true },
    orderBy: [{ livePayoutChangedAt: { sort: "desc", nulls: "last" } }, { sellerId: "asc" }],
    select: { sellerId: true, livePayoutChangedAt: true, earnTiming: true, rates: true, seller: { select: { shopName: true, slug: true, status: true } } },
  });
  const ids = policies.map((p) => p.sellerId);
  const [balances, monthPaid, grants] = await Promise.all([
    db.rewardBalance.groupBy({ by: ["sellerId"], where: { sellerId: { in: ids }, balance: { gt: 0 } }, _sum: { balance: true }, _count: { _all: true } }),
    // 기존 관리자 잔액 비율 계약(sellerRewards): KST 이번 달 paidAt 순액. 생성 시각 매출 cohort와 다르다.
    db.order.groupBy({ by: ["sellerId"], where: { sellerId: { in: ids }, paidAt: { gte: monthStart, lt: now } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.$queryRaw<{ sellerId: string; succeeded: number; observedFailed: number; uncertainModeFailed: number; undatedFailed: number; manualAmount: bigint }[]>`
      SELECT "sellerId",
        count(*) FILTER (WHERE status = 'SUCCEEDED' AND "testMode" = false AND "processedAt" >= ${todayStart} AND "processedAt" < ${now})::int AS succeeded,
        count(*) FILTER (WHERE status = 'FAILED' AND "failureReason" IS DISTINCT FROM 'member_withdrawn' AND "processedAt" >= ${todayStart} AND "processedAt" < ${now})::int AS "observedFailed",
        count(*) FILTER (WHERE status = 'FAILED' AND "failureReason" IS DISTINCT FROM 'member_withdrawn' AND "testMode" = true AND "processedAt" >= ${todayStart} AND "processedAt" < ${now})::int AS "uncertainModeFailed",
        count(*) FILTER (WHERE status = 'FAILED' AND "failureReason" IS DISTINCT FROM 'member_withdrawn' AND "processedAt" IS NULL)::int AS "undatedFailed",
        coalesce(sum(amount::bigint) FILTER (WHERE type = 'ADJUST' AND status = 'SUCCEEDED' AND "testMode" = false AND "processedAt" >= ${manualSince} AND "processedAt" < ${now}), 0)::bigint AS "manualAmount"
      FROM "RewardLedger" WHERE "sellerId" = ANY(${ids}::uuid[]) AND amount > 0 AND type IN ('EARN', 'RANKING_BONUS', 'ADJUST')
        AND (("processedAt" >= ${manualSince} AND "processedAt" < ${now}) OR (status = 'FAILED' AND "processedAt" IS NULL))
      GROUP BY "sellerId"`,
  ]);
  return {
    at: now,
    windows: { today: { start: todayStart, end: now }, month: { start: monthStart, end: now }, manual30Days: { start: manualSince, end: now, kind: "ROLLING_30_DAYS" as const } },
    sources: { monthTradingAmount: "INTERNAL_ORDER_PAID_AT_CURRENT_REFUND_NET", payout: "CURRENT_POSITIVE_GRANT_LEDGER_RESULTS", manual: "SUCCEEDED_NON_TEST_POSITIVE_ADJUST_PROCESSED_AT", failureAttempts: "NOT_RECORDED", maxConfiguredRewardRatePercent: "STORED_POLICY_RATE_VALUES" } as const,
    items: policies.map((p) => {
      const b = balances.find((r) => r.sellerId === p.sellerId);
      const m = monthPaid.find((r) => r.sellerId === p.sellerId);
      const g = grants.find((r) => r.sellerId === p.sellerId);
      const amount = b?._sum.balance ?? 0;
      const monthTradingAmount = (m?._sum.totalAmount ?? 0) - (m?._sum.refundAmount ?? 0);
      const balanceRatioPercent = monthTradingAmount > 0 ? Math.round(amount / monthTradingAmount * 1000) / 10 : null;
      const observedFailed = g?.observedFailed ?? 0, uncertainModeFailed = g?.uncertainModeFailed ?? 0, undatedFailed = g?.undatedFailed ?? 0;
      const failed = uncertainModeFailed || undatedFailed ? null : observedFailed;
      const rates = p.rates && typeof p.rates === "object" && !Array.isArray(p.rates) ? Object.values(p.rates) : null;
      const configured = rates?.flatMap((r) => r && typeof r === "object" && !Array.isArray(r) ? [r.card, r.bankTransfer].filter((v) => v !== undefined) : [null]);
      const maxConfiguredRewardRatePercent = configured?.every((r) => typeof r === "number" && Number.isFinite(r) && r >= 0 && r <= RATE_MAX) ? Math.max(0, ...configured as number[]) : null;
      return {
        sellerId: p.sellerId,
        shopName: p.seller.shopName,
        slug: p.seller.slug,
        status: p.seller.status,
        enabledAt: p.livePayoutChangedAt,
        earnTiming: p.earnTiming,
        outstanding: { amount, members: b?._count._all ?? 0 },
        monthTradingAmount, balanceRatioPercent, maxConfiguredRewardRatePercent,
        payoutToday: { succeeded: g?.succeeded ?? 0, failed, observedFailed, uncertainModeFailed, undatedFailed },
        manualGrant30DaysAmount: Number(g?.manualAmount ?? 0),
        signals: {
          balanceRatio: { thresholdPercent: 25, state: balanceRatioPercent === null ? "UNAVAILABLE" : balanceRatioPercent > 25 ? "WARN" : "OK" },
          payoutFailure: { state: failed === null ? "UNKNOWN" : failed > 0 ? "WARN" : "OK" },
          manualConcentration: { state: "NOT_DEFINED" },
        },
      };
    }),
  };
}

// MA-100 실시간 감시(조회만, platform.read). 실제로 재는 값만 준다. 웹훅은 받은 기록을 따로 저장하지 않아 재지 않는다(not_measured).
// - servers: 살아 있는 앱 인스턴스(종료 표시 없음) 수와 그중 정상(2시간 안에 정기 실행 기록이 있음)·멈춤·신호 없음(등록 뒤 기록 없음) 수.
//   정기 실행은 한 시간마다 돌아 2시간을 기준으로 한다.
// - jobs: 작업별 마지막 실행(모든 살아 있는 인스턴스 중 가장 늦은 것)·그때 결과·마지막 성공. 오류 문구는 최고관리자(system.manage)에게만.
// - queue: 실행할 때가 된 자동 연결 작업 대기 수와 가장 오래 기다린 시각.
// - paymentChecks: 결제 결과 확인을 기다리는 건수와 가장 오래된 시각(주문 결제 승인 중·구독 청구·자동 연결 결제·발송 충전).
// - autoActions: 시스템이 스스로 한 처리(로그 추적의 SYSTEM 행) 최근 20건. 열린 장애(수집기 사건)는 incidents.
export const SERVER_HEALTHY_MS = 2 * 3_600_000;

export async function opsMonitor(db: PrismaClient, admin: AdminSessionContext) {
  requireRead(admin);
  const now = await dbNow(db);
  const showErrors = adminCan(admin.admin.role, "system.manage");
  const beats = await db.$queryRaw<{ instance: string; registeredAt: Date; job: string | null; lastRunAt: Date | null; lastStatus: string | null; lastOkAt: Date | null; lastError: string | null }[]>`
    SELECT i."name" AS "instance", i."registeredAt", h."job", h."lastRunAt", h."lastStatus", h."lastOkAt", h."lastError"
    FROM "OpsInstance" i LEFT JOIN "OpsHeartbeat" h ON h."instance" = i."name" AND h."generation" = i."generation"
    WHERE i."retiredAt" IS NULL
    ORDER BY i."name", h."job" NULLS FIRST`;
  const byInstance = new Map<string, { lastRunAt: number | null }>();
  for (const b of beats) {
    const cur = byInstance.get(b.instance) ?? { lastRunAt: null };
    if (b.lastRunAt) cur.lastRunAt = Math.max(cur.lastRunAt ?? 0, b.lastRunAt.getTime());
    byInstance.set(b.instance, cur);
  }
  const servers = { total: byInstance.size, healthy: 0, stale: 0, noSignal: 0 };
  for (const v of byInstance.values()) {
    if (v.lastRunAt === null) servers.noSignal++;
    else if (now.getTime() - v.lastRunAt <= SERVER_HEALTHY_MS) servers.healthy++;
    else servers.stale++;
  }
  const jobMap = new Map<string, { job: string; lastRunAt: Date; lastStatus: string; lastOkAt: Date | null; lastError: string | null; instances: number }>();
  for (const b of beats) {
    if (!b.job || !b.lastRunAt) continue;
    const cur = jobMap.get(b.job);
    const okAt = cur?.lastOkAt && b.lastOkAt ? (cur.lastOkAt > b.lastOkAt ? cur.lastOkAt : b.lastOkAt) : (cur?.lastOkAt ?? b.lastOkAt);
    if (!cur || b.lastRunAt > cur.lastRunAt) {
      jobMap.set(b.job, { job: b.job, lastRunAt: b.lastRunAt, lastStatus: b.lastStatus ?? "no_signal", lastOkAt: okAt, lastError: b.lastError, instances: (cur?.instances ?? 0) + 1 });
    } else {
      cur.lastOkAt = okAt;
      cur.instances++;
    }
  }
  const jobs = [...jobMap.values()]
    .sort((a, b) => a.job.localeCompare(b.job))
    .map(({ lastError, ...j }) => ({ ...j, healthy: now.getTime() - j.lastRunAt.getTime() <= SERVER_HEALTHY_MS && j.lastStatus !== "failed", ...(showErrors ? { lastError } : {}) }));

  const pending = async (kind: string, p: Promise<{ _count: { _all: number }; _min: { createdAt: Date | null } }>) => {
    const r = await p;
    return { kind, pending: r._count._all, oldestAt: r._min.createdAt };
  };
  const [queued, paymentChecks, autoActions, incidents] = await Promise.all([
    db.automationJob.aggregate({ where: { status: "QUEUED", runAfter: { lte: now } }, _count: { _all: true }, _min: { queuedAt: true } }),
    Promise.all([
      pending("order_payment", db.payment.aggregate({ where: { status: "APPROVING" }, _count: { _all: true }, _min: { createdAt: true } })),
      pending("subscription", db.subscriptionPayment.aggregate({ where: { status: "PENDING" }, _count: { _all: true }, _min: { createdAt: true } })),
      pending("automation", db.automationPayment.aggregate({ where: { status: "PENDING" }, _count: { _all: true }, _min: { createdAt: true } })),
      pending("message_charge", db.messageCharge.aggregate({ where: { status: "PENDING" }, _count: { _all: true }, _min: { createdAt: true } })),
    ]),
    db.auditLog.findMany({
      where: { actorType: "SYSTEM" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: { id: true, action: true, targetType: true, targetId: true, sellerId: true, createdAt: true },
    }),
    db.$queryRaw<{ source: string; key: string; kind: string; severity: string; message: string; occurredAt: Date }[]>`
      SELECT DISTINCT ON ("source", "key") "source", "key", "kind", "severity", "message", "occurredAt"
      FROM "OpsEvent" WHERE "kind" IN ('incident_open', 'incident_close')
      ORDER BY "source", "key", "seq" DESC`,
  ]);
  return {
    at: now,
    servers,
    jobs,
    queue: { automationQueued: queued._count._all, oldestQueuedAt: queued._min.queuedAt },
    paymentChecks,
    webhooks: "not_measured" as const,
    autoActions,
    incidents: incidents.filter((e) => e.kind === "incident_open").map(({ kind: _k, ...e }) => e),
  };
}
