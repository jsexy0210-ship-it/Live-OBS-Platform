import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { subscriptionAccessCounts } from "./billing";

// 마스터 관리자 통합 대시보드 요약(MA-001, platform.read, 조회만). 숫자만 주고 개인정보는 넣지 않는다.
// - sellers: 상태별 파트너스 수(승인 대기 = 「확인 필요」 포함)
// - liveBroadcasts: 지금 방송 중(LIVE) 수
// - ordersToday: 오늘(KST 0시부터) 들어온 주문 수와, 오늘 결제된 주문 수·결제 금액(환불액 뺌)
// - subscriptions: 이용 상태별 수(구독 현황 MA-023과 같은 기준). 연체 = grace
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

export async function adminDashboard(db: PrismaClient, admin: AdminSessionContext, opts: { now?: Date } = {}) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const now = opts.now ?? (await dbNow(db));
  const todayStart = new Date(Math.floor((now.getTime() + KST_MS) / DAY_MS) * DAY_MS - KST_MS);
  const [byStatus, liveBroadcasts, created, paid, subscriptions] = await Promise.all([
    db.seller.groupBy({ by: ["status"], _count: { _all: true } }),
    db.broadcastSession.count({ where: { status: "LIVE" } }),
    db.order.count({ where: { createdAt: { gte: todayStart, lte: now } } }),
    db.order.aggregate({ where: { paidAt: { gte: todayStart, lte: now } }, _count: true, _sum: { totalAmount: true, refundAmount: true } }),
    subscriptionAccessCounts(db, now),
  ]);
  const sellers = { PENDING: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0, CLOSED: 0 } as Record<string, number>;
  for (const r of byStatus) sellers[r.status] = r._count._all;
  return {
    at: now,
    todayStart,
    sellers: { total: Object.values(sellers).reduce((a, b) => a + b, 0), ...sellers },
    liveBroadcasts,
    ordersToday: { created, paid: paid._count, paidAmount: (paid._sum.totalAmount ?? 0) - (paid._sum.refundAmount ?? 0) },
    subscriptions,
    pastDue: subscriptions.grace,
  };
}
