import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/seller/stats/hourly/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 시간대별 주문 통계 GET /api/seller/stats/hourly
beforeEach(resetDb);
afterAll(() => db.$disconnect());

type Shop = Awaited<ReturnType<typeof createSeller>>;
const cookieOf = async (s: Shop, user: Awaited<ReturnType<typeof createSellerUser>>) =>
  `lo_seller=${(await createSellerSession(db, s.seller.id, user.id, {}, user.credentialVersion)).token}`;
const get = (q: string, cookie?: string) => route(new Request(`http://localhost:3000/api/seller/stats/hourly?${q}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));
const order = async (s: Shop, at: string, extra: Record<string, unknown> = {}) => {
  const buyer = await createBuyer(s.seller.id, s.grade.id);
  await db.order.create({ data: { sellerId: s.seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status: "PAID", createdAt: new Date(at), paidAt: new Date(at), ...extra } as never });
};

describe("시간대별 주문 통계", () => {
  it("주문 시각의 KST 시로 묶고 24칸을 모두 주며, 최다 시간대·취소·환불·다른 쇼핑몰 분리를 지킨다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    // KST 10/2 09시(=10/2 00:00Z) 2건, KST 10/2 21시 1건(환불 400), KST 10/3 00시(=10/2 15:00Z) 1건(결제 전 취소)
    await order(a, "2026-10-02T00:10:00Z");
    await order(a, "2026-10-02T00:50:00Z");
    await order(a, "2026-10-02T12:00:00Z", { status: "REFUNDED", refundAmount: 400 });
    await order(a, "2026-10-02T15:00:00Z", { status: "CANCELLED", paidAt: null });
    await order(a, "2026-10-04T00:00:00Z"); // 기간 밖
    await order(b, "2026-10-02T00:30:00Z"); // 다른 쇼핑몰
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const res = await get("from=2026-10-02&to=2026-10-03", await cookieOf(a, owner));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.hours).toHaveLength(24);
    expect(body.hours.map((h: { hour: number }) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(body.hours[9]).toMatchObject({ orders: 2, paidOrders: 2, revenue: 2000, cancelled: 0, refunded: 0 });
    expect(body.hours[21]).toMatchObject({ orders: 1, paidOrders: 1, revenue: 1000, refunded: 1, refundAmount: 400, netRevenue: 600 });
    expect(body.hours[0]).toMatchObject({ orders: 1, paidOrders: 0, revenue: 0, cancelled: 1 });
    expect(body.hours[5]).toMatchObject({ orders: 0, revenue: 0, netRevenue: 0 });
    expect(body.totalOrders).toBe(4);
    expect(body.peakHour).toBe(9);
  });

  it("주문이 없으면 peakHour는 null, 주문 수가 같으면 이른 시간이다", async () => {
    const a = await createSeller();
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const empty = await (await get("from=2026-10-02&to=2026-10-02", await cookieOf(a, owner))).json();
    expect(empty).toMatchObject({ totalOrders: 0, peakHour: null });
    await order(a, "2026-10-02T14:00:00Z"); // KST 23시
    await order(a, "2026-10-02T01:00:00Z"); // KST 10시
    expect((await (await get("from=2026-10-02&to=2026-10-03", await cookieOf(a, owner))).json()).peakHour).toBe(10);
  });

  it("통계 권한이 있는 직원만 보고, 잘못된 기간은 400, 로그인 없음은 401", async () => {
    const a = await createSeller();
    const q = "from=2026-10-02&to=2026-10-03";
    const withPerm = await createSellerUser(a.seller.id, { permissions: ["SALES_VIEW"] });
    const without = await createSellerUser(a.seller.id, { permissions: ["ORDER_SHIPPING"] });
    expect((await get(q, await cookieOf(a, withPerm))).status).toBe(200);
    expect((await get(q, await cookieOf(a, without))).status).toBe(403);
    expect((await get("from=2026-10-03&to=2026-10-02", await cookieOf(a, withPerm))).status).toBe(400);
    expect((await get("", await cookieOf(a, withPerm))).status).toBe(400);
    expect((await get(q)).status).toBe(401);
  });
});
