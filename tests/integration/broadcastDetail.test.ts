import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/seller/broadcast/[broadcastId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { DETAIL_ORDER_PAGE } from "../../lib/server/broadcast/detail";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-055 방송 상세: 집계·주문 목록(방송 시간 안, 다음 쪽, 분리 보관 제외, 완료 시각)·HIT, 권한(BROADCAST_RUN), 다른 판매자 방송 404.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const MIN = 60_000;
const at = (base: Date, m: number) => new Date(base.getTime() + m * MIN);
async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const runner = await createSellerUser(seller.id, { permissions: ["BROADCAST_RUN"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  return { seller, buyer, owner: await cookieOf(owner.email), runner: await cookieOf(runner.email), noPerm: await cookieOf(other.email) };
}
const detail = async (cookie: string, id: string, q = "") => {
  const res = await detailRoute(new Request(`${BASE}/api/seller/broadcast/${id}${q}`, { headers: { host: "localhost:3000", cookie } }), { params: Promise.resolve({ broadcastId: id }) });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};
async function order(sellerId: string, buyerId: string, createdAt: Date, data: Record<string, unknown> = {}) {
  const r = await createPaidOrderItem(sellerId, buyerId);
  await db.order.update({ where: { id: r.order.id }, data: { createdAt, paidAt: createdAt, ...data } });
  return r;
}

describe("방송 상세", () => {
  it("방송 시간 안 주문·HIT와 집계, 완료 시각, 분리 보관 주문 제외. 다른 판매자는 404, 권한 없는 직원은 403", async () => {
    const s = await shop();
    const start = new Date("2026-10-01T20:00:00+09:00");
    const b = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", title: "목요 방송", startedAt: start, endedAt: at(start, 60) } });
    await order(s.seller.id, s.buyer.id, at(start, -5)); // 방송 전
    const a = await order(s.seller.id, s.buyer.id, at(start, 10));
    await order(s.seller.id, s.buyer.id, at(start, 20), { status: "CANCELLED", paidAt: null });
    await order(s.seller.id, s.buyer.id, at(start, 30), { legalHoldAt: new Date() }); // 분리 보관(목록 제외)
    await order(s.seller.id, s.buyer.id, at(start, 90)); // 방송 뒤
    await db.queueItem.create({
      data: { sellerId: s.seller.id, orderId: a.order.id, orderItemId: a.item.id, status: "DONE", position: 1, receivedAt: at(start, 10), nicknameSnapshot: "닉네임", productLabel: "부스터 팩", quantity: 1, doneAt: at(start, 15) },
    });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "닉네임", cardName: "리자몽", createdAt: at(start, 16) } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "닉네임", cardName: "방송 뒤", createdAt: at(start, 70) } });

    for (const cookie of [s.owner, s.runner]) {
      const r = await detail(cookie, b.id);
      expect(r.status).toBe(200);
      expect(r.body.broadcast).toMatchObject({ id: b.id, title: "목요 방송", status: "ended" });
      expect(r.body.summary).toEqual({ orders: 3, paidOrders: 2, sales: 10000, completed: 1, cancelled: 1, hits: 1, avgOpenSeconds: expect.toSatisfy((v: unknown) => v === null || typeof v === "number"), maxWaiting: 1 });
      expect(r.body.orders.map((o: { id: string; status: string; completedAt: string | null }) => [o.id, o.status, o.completedAt])).toEqual([
        [a.order.id, "PAID", at(start, 15).toISOString()],
        [expect.any(String), "CANCELLED", null],
      ]);
      expect(r.body.orders[0]).toMatchObject({ orderNoLabel: expect.stringMatching(/^\d{8}-\d{4,}$/), nickname: "닉네임", totalAmount: 5000, items: [{ productName: "부스터 팩", optionName: "1팩", quantity: 1, unitPrice: 5000 }] });
      expect(r.body.hits.map((h: { cardName: string }) => h.cardName)).toEqual(["리자몽"]);
      expect(r.body.nextCursor).toBeNull();
    }
    expect((await detail(s.noPerm, b.id)).status).toBe(403);
    const t = await shop();
    expect((await detail(t.owner, b.id)).status).toBe(404);
    expect((await detail(s.owner, "not-a-uuid")).status).toBe(404);
  });

  it("주문이 많으면 다음 쪽으로 나눠 준다(방송 중이면 지금까지)", async () => {
    const s = await shop();
    const start = new Date(Date.now() - 120 * MIN);
    const b = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", startedAt: start } });
    for (let i = 0; i < DETAIL_ORDER_PAGE + 2; i++) await order(s.seller.id, s.buyer.id, at(start, 1 + i));
    const p1 = await detail(s.owner, b.id);
    expect([p1.body.broadcast.status, p1.body.orders.length, p1.body.summary.orders]).toEqual(["live", DETAIL_ORDER_PAGE, DETAIL_ORDER_PAGE + 2]);
    const p2 = await detail(s.owner, b.id, `?cursor=${p1.body.nextCursor}`);
    expect([p2.body.orders.length, p2.body.nextCursor]).toEqual([2, null]);
    expect(new Set([...p1.body.orders, ...p2.body.orders].map((o: { id: string }) => o.id)).size).toBe(DETAIL_ORDER_PAGE + 2);
  });
});
