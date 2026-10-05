import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as liveGet } from "../../app/api/admin/ops/live-broadcasts/route";
import { GET as payoutGet } from "../../app/api/admin/ops/live-payout-sellers/route";
import { GET as activityGet } from "../../app/api/admin/ops/seller-activity/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { ACTIVITY_PAGE_SIZE } from "../../lib/server/admin/ops";
import { prisma } from "../../lib/server/db";
import { issueOverlayToken, resolveOverlayToken } from "../../lib/server/overlay/token";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 마스터 관리자 운영 현황(MA-041·042·043, 조회만): 권한, 방송 중 집계, 오버레이 마지막 접속(1분에 한 번 기록·2분 안이면 접속 중),
// 오늘 주문·결제, 가입 최신 순 커서, 적립금 실지급 파트너스의 남은 적립금 합계. 구매자 개인정보는 없다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role = "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = async (fn: (r: Request) => Promise<Response>, path: string, cookie: string) => {
  const r = await fn(new Request(BASE + path, { headers: { host: "localhost:3000", cookie } }));
  return { status: r.status, body: await r.json() };
};
async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: owner.permissions, readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  return { seller, grade, ctx, buyer };
}
async function queued(sellerId: string, buyerId: string, broadcastSessionId: string, status: "WAITING" | "OPENING" | "DONE" | "CANCELLED", position: number) {
  const { order, item } = await createPaidOrderItem(sellerId, buyerId);
  await db.queueItem.create({
    data: { sellerId, orderId: order.id, orderItemId: item.id, broadcastSessionId, status, position, receivedAt: new Date(), nicknameSnapshot: "비밀닉네임", productLabel: "부스터 팩", quantity: 1 },
  });
  return order;
}

describe("권한", () => {
  it("마스터 관리자 모든 역할이 본다. 로그인이 없으면 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const c = await adminCookie(role);
      expect((await get(liveGet, "/api/admin/ops/live-broadcasts", c)).status).toBe(200);
      expect((await get(activityGet, "/api/admin/ops/seller-activity", c)).status).toBe(200);
      expect((await get(payoutGet, "/api/admin/ops/live-payout-sellers", c)).status).toBe(200);
    }
    expect((await get(liveGet, "/api/admin/ops/live-broadcasts", "")).status).toBe(401);
    expect((await get(activityGet, "/api/admin/ops/seller-activity", "")).status).toBe(401);
    expect((await get(payoutGet, "/api/admin/ops/live-payout-sellers", "")).status).toBe(401);
  });
});

describe("방송 중 파트너스(MA-041)", () => {
  it("방송 중인 방송만, 주문대기 상태별 수와 주문 수, 오버레이 접속을 준다. 구매자 정보는 없다", async () => {
    const a = await shop();
    const b = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: a.seller.id, status: "LIVE", title: "저녁 방송" } });
    await db.broadcastSession.create({ data: { sellerId: b.seller.id, status: "ENDED", endedAt: new Date() } });
    await queued(a.seller.id, a.buyer.id, live.id, "WAITING", 1);
    await queued(a.seller.id, a.buyer.id, live.id, "WAITING", 2);
    await queued(a.seller.id, a.buyer.id, live.id, "DONE", 3);
    await queued(a.seller.id, a.buyer.id, live.id, "CANCELLED", 4);
    const token = await issueOverlayToken(db, a.ctx);
    const c = await adminCookie();
    let r = await get(liveGet, "/api/admin/ops/live-broadcasts", c);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({
      sellerId: a.seller.id,
      shopName: a.seller.shopName,
      slug: a.seller.slug,
      broadcastId: live.id,
      title: "저녁 방송",
      queue: { waiting: 2, opening: 0, done: 1, cancelled: 1 },
      orders: 3,
      overlay: { hasUrl: true, connected: false, lastSeenAt: null },
    });
    // 오버레이 주소로 접속하면 접속 중
    expect(await resolveOverlayToken(db, token)).toBe(a.seller.id);
    r = await get(liveGet, "/api/admin/ops/live-broadcasts", c);
    expect(r.body.items[0].overlay).toMatchObject({ hasUrl: true, connected: true, lastSeenAt: expect.any(String) });
    // 2분 넘게 접속이 없으면 접속 끊김
    await db.overlayToken.updateMany({ where: { sellerId: a.seller.id }, data: { lastSeenAt: new Date(Date.now() - 3 * 60_000) } });
    r = await get(liveGet, "/api/admin/ops/live-broadcasts", c);
    expect(r.body.items[0].overlay.connected).toBe(false);
    const raw = JSON.stringify(r.body);
    for (const leak of ["비밀닉네임", a.buyer.phone, a.buyer.id, "buyerMemberId", "orderId"]) expect(raw).not.toContain(leak);
  });

  it("마지막 접속 시각은 1분이 지났을 때만 다시 쓴다", async () => {
    const a = await shop();
    const token = await issueOverlayToken(db, a.ctx);
    const at = async () => (await db.overlayToken.findFirstOrThrow({ where: { sellerId: a.seller.id, revokedAt: null } })).lastSeenAt!.getTime();
    const recent = new Date(Date.now() - 30_000);
    await db.overlayToken.updateMany({ where: { sellerId: a.seller.id }, data: { lastSeenAt: recent } });
    await resolveOverlayToken(db, token);
    expect(await at()).toBe(recent.getTime());
    const old = new Date(Date.now() - 90_000);
    await db.overlayToken.updateMany({ where: { sellerId: a.seller.id }, data: { lastSeenAt: old } });
    await resolveOverlayToken(db, token);
    expect(await at()).toBeGreaterThan(old.getTime());
    // 폐기된 토큰·잘못된 토큰은 기록하지 않는다
    await issueOverlayToken(db, a.ctx);
    const revoked = await db.overlayToken.findFirstOrThrow({ where: { sellerId: a.seller.id, revokedAt: { not: null } } });
    await db.overlayToken.update({ where: { id: revoked.id }, data: { lastSeenAt: null } });
    expect(await resolveOverlayToken(db, token)).toBeNull();
    expect((await db.overlayToken.findUniqueOrThrow({ where: { id: revoked.id } })).lastSeenAt).toBeNull();
  });
});

describe("파트너스별 주문·오버레이 접속(MA-042)", () => {
  it("오늘 들어온 주문·결제 수와 결제 금액(환불 뺌), 방송 중 여부. 승인 대기 파트너스와 어제 주문은 빠진다", async () => {
    const a = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: a.seller.id, status: "LIVE" } });
    await createPaidOrderItem(a.seller.id, a.buyer.id);
    const { order: refunded } = await createPaidOrderItem(a.seller.id, a.buyer.id);
    await db.order.update({ where: { id: refunded.id }, data: { refundAmount: 2000 } });
    const { order: old } = await createPaidOrderItem(a.seller.id, a.buyer.id);
    const yesterday = new Date(Date.now() - 2 * 86_400_000);
    await db.order.update({ where: { id: old.id }, data: { createdAt: yesterday, paidAt: yesterday } });
    const pending = await createSeller();
    await db.seller.update({ where: { id: pending.seller.id }, data: { status: "PENDING" } });
    const r = await get(activityGet, "/api/admin/ops/seller-activity", await adminCookie());
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { sellerId: string }) => i.sellerId)).toEqual([a.seller.id]);
    expect(r.body.items[0]).toMatchObject({
      status: "ACTIVE",
      ordersToday: { created: 2, paid: 2, paidAmount: 8000 },
      live: { startedAt: live.startedAt.toISOString() },
      overlay: { hasUrl: false, connected: false, lastSeenAt: null },
    });
    expect(r.body.nextCursor).toBeNull();
  });

  it(`가입 최신 순 ${ACTIVITY_PAGE_SIZE}곳씩 커서로 이어진다. 잘못된 커서는 400`, async () => {
    const base = Date.now() - 1_000_000;
    const ids: string[] = [];
    for (let i = 0; i < ACTIVITY_PAGE_SIZE + 2; i++) {
      const { seller } = await createSeller();
      await db.seller.update({ where: { id: seller.id }, data: { createdAt: new Date(base + i * 1000) } });
      ids.push(seller.id);
    }
    const c = await adminCookie();
    const first = await get(activityGet, "/api/admin/ops/seller-activity", c);
    expect(first.body.items).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(first.body.items[0].sellerId).toBe(ids[ids.length - 1]);
    const second = await get(activityGet, `/api/admin/ops/seller-activity?cursor=${encodeURIComponent(first.body.nextCursor)}`, c);
    expect(second.body.items.map((i: { sellerId: string }) => i.sellerId)).toEqual([ids[1], ids[0]]);
    expect(second.body.nextCursor).toBeNull();
    expect((await get(activityGet, "/api/admin/ops/seller-activity?cursor=bad", c)).status).toBe(400);
  });
});

describe("적립금 실지급 켜진 파트너스(MA-043)", () => {
  it("실지급을 켠 파트너스만, 남은 적립금 합계와 적립금이 남은 회원 수", async () => {
    const a = await shop();
    const b = await shop();
    const enabledAt = new Date(Date.now() - 60_000);
    await db.rewardPolicy.create({ data: { sellerId: a.seller.id, livePayoutEnabled: true, livePayoutChangedAt: enabledAt } });
    await db.rewardPolicy.create({ data: { sellerId: b.seller.id, livePayoutEnabled: false } });
    const a2 = await createBuyer(a.seller.id, a.grade.id);
    const a3 = await createBuyer(a.seller.id, a.grade.id);
    await db.rewardBalance.createMany({
      data: [
        { sellerId: a.seller.id, buyerMemberId: a.buyer.id, balance: 300 },
        { sellerId: a.seller.id, buyerMemberId: a2.id, balance: 1200 },
        { sellerId: a.seller.id, buyerMemberId: a3.id, balance: 0 },
        { sellerId: b.seller.id, buyerMemberId: b.buyer.id, balance: 999 },
      ],
    });
    const r = await get(payoutGet, "/api/admin/ops/live-payout-sellers", await adminCookie());
    expect(r.body.items).toEqual([
      { sellerId: a.seller.id, shopName: a.seller.shopName, slug: a.seller.slug, status: "ACTIVE", enabledAt: enabledAt.toISOString(), earnTiming: "ON_DELIVERY", outstanding: { amount: 1500, members: 2 } },
    ]);
  });
});
