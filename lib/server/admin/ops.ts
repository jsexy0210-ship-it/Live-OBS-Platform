import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { OVERLAY_ONLINE_MS } from "../overlay/token";

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
  const sessions = await db.broadcastSession.findMany({
    where: { status: "LIVE" },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: 200,
    select: { id: true, title: true, startedAt: true, sellerId: true, seller: { select: { shopName: true, slug: true, status: true } } },
  });
  const ids = sessions.map((s) => s.id);
  const [byStatus, orders] = await Promise.all([
    db.queueItem.groupBy({ by: ["broadcastSessionId", "status"], where: { broadcastSessionId: { in: ids } }, _count: { _all: true } }),
    db.queueItem.groupBy({ by: ["broadcastSessionId", "orderId"], where: { broadcastSessionId: { in: ids }, status: { not: "CANCELLED" } } }),
  ]);
  const seen = await overlaySeen(db, [...new Set(sessions.map((s) => s.sellerId))], now);
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
      overlay: seen(s.sellerId),
    };
  });
  return { at: now, items };
}

// MA-042: 승인된 파트너스(이용 중·정지)별 오늘 주문·결제와 방송·오버레이 접속. 가입 순 최신 50곳씩 커서.
export async function listSellerActivity(db: PrismaClient, admin: AdminSessionContext, q: { cursor?: string | null }) {
  requireRead(admin);
  const now = await dbNow(db);
  const todayStart = todayStartOf(now);
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
  const [created, paid, live] = await Promise.all([
    db.order.groupBy({ by: ["sellerId"], where: { sellerId: { in: ids }, createdAt: { gte: todayStart, lte: now } }, _count: { _all: true } }),
    db.order.groupBy({ by: ["sellerId"], where: { sellerId: { in: ids }, paidAt: { gte: todayStart, lte: now } }, _count: { _all: true }, _sum: { totalAmount: true, refundAmount: true } }),
    db.broadcastSession.findMany({ where: { sellerId: { in: ids }, status: "LIVE" }, select: { sellerId: true, startedAt: true } }),
  ]);
  const seen = await overlaySeen(db, ids, now);
  const items = page.map((s) => {
    const p = paid.find((r) => r.sellerId === s.id);
    const l = live.find((r) => r.sellerId === s.id);
    return {
      sellerId: s.id,
      shopName: s.shopName,
      slug: s.slug,
      status: s.status,
      ordersToday: {
        created: created.find((r) => r.sellerId === s.id)?._count._all ?? 0,
        paid: p?._count._all ?? 0,
        paidAmount: (p?._sum.totalAmount ?? 0) - (p?._sum.refundAmount ?? 0),
      },
      live: l ? { startedAt: l.startedAt } : null,
      overlay: seen(s.id),
    };
  });
  const last = page[page.length - 1];
  return { ok: true as const, at: now, todayStart, items, nextCursor: rows.length > ACTIVITY_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null };
}

// MA-043: 적립금 실지급을 켠 파트너스. 켠 시각 최근 순. 남은 적립금 합계·적립금이 남은 회원 수(개인 단위는 주지 않음).
export async function listLivePayoutSellers(db: PrismaClient, admin: AdminSessionContext) {
  requireRead(admin);
  const policies = await db.rewardPolicy.findMany({
    where: { livePayoutEnabled: true },
    orderBy: [{ livePayoutChangedAt: { sort: "desc", nulls: "last" } }, { sellerId: "asc" }],
    select: { sellerId: true, livePayoutChangedAt: true, earnTiming: true, seller: { select: { shopName: true, slug: true, status: true } } },
  });
  const ids = policies.map((p) => p.sellerId);
  const balances = await db.rewardBalance.groupBy({ by: ["sellerId"], where: { sellerId: { in: ids }, balance: { gt: 0 } }, _sum: { balance: true }, _count: { _all: true } });
  return {
    items: policies.map((p) => {
      const b = balances.find((r) => r.sellerId === p.sellerId);
      return {
        sellerId: p.sellerId,
        shopName: p.seller.shopName,
        slug: p.seller.slug,
        status: p.seller.status,
        enabledAt: p.livePayoutChangedAt,
        earnTiming: p.earnTiming,
        outstanding: { amount: b?._sum.balance ?? 0, members: b?._count._all ?? 0 },
      };
    }),
  };
}
