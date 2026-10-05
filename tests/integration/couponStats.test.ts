import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/seller/stats/coupons/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쿠폰 사용 성과 GET /api/seller/stats/coupons
beforeEach(resetDb);
afterAll(() => db.$disconnect());

type Shop = Awaited<ReturnType<typeof createSeller>>;
const cookieOf = async (s: Shop, user: Awaited<ReturnType<typeof createSellerUser>>) =>
  `lo_seller=${(await createSellerSession(db, s.seller.id, user.id, {}, user.credentialVersion)).token}`;
const get = (q: string, cookie?: string) => route(new Request(`http://localhost:3000/api/seller/stats/coupons?${q}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));

async function coupon(s: Shop, code: string, name: string) {
  return db.coupon.create({ data: { sellerId: s.seller.id, name, issueMethod: "CODE", code, benefit: "AMOUNT", value: 2000, startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: new Date("2027-01-01T00:00:00Z") } });
}
async function order(s: Shop, at: string, totalAmount: number, opts: { paid?: boolean; refundAmount?: number; coupon?: { id: string; discount: number; restored?: boolean } } = {}) {
  const buyer = await createBuyer(s.seller.id, s.grade.id);
  const paid = opts.paid ?? true;
  const o = await db.order.create({
    data: {
      sellerId: s.seller.id,
      orderNo: Math.floor(Math.random() * 1e9),
      buyerMemberId: buyer.id,
      broadcastNicknameSnapshot: "닉",
      totalAmount,
      status: paid ? "PAID" : "PENDING_PAYMENT",
      createdAt: new Date(at),
      paidAt: paid ? new Date(at) : null,
      refundAmount: opts.refundAmount ?? null,
    } as never,
  });
  if (opts.coupon) {
    const bc = await db.buyerCoupon.create({ data: { sellerId: s.seller.id, couponId: opts.coupon.id, buyerMemberId: buyer.id, issuedAt: new Date("2026-09-01T00:00:00Z"), expiresAt: new Date("2027-01-01T00:00:00Z") } });
    await db.couponRedemption.create({
      data: { sellerId: s.seller.id, orderId: o.id, couponId: opts.coupon.id, buyerCouponId: bc.id, benefit: "AMOUNT", discountAmount: opts.coupon.discount, restoredAt: opts.coupon.restored ? new Date(at) : null },
    });
  }
}

describe("쿠폰 사용 성과", () => {
  it("결제된 주문을 쿠폰 쓴 주문과 안 쓴 주문으로 나눠 순매출·객단가·할인액을 비교하고, 쿠폰별 상위를 준다", async () => {
    const a = await createSeller();
    const other = await createSeller();
    const c1 = await coupon(a, "WELCOME1", "첫 구매");
    const c2 = await coupon(a, "SPRING22", "봄맞이");
    const oc = await coupon(other, "OTHER111", "남의 쿠폰");
    const IN = "2026-10-02T03:00:00Z";
    await order(a, IN, 10_000, { coupon: { id: c1.id, discount: 2_000 } });
    await order(a, IN, 20_000, { refundAmount: 5_000, coupon: { id: c1.id, discount: 2_000 } }); // 부분 환불: 순매출 15,000
    await order(a, IN, 30_000, { coupon: { id: c2.id, discount: 3_000, restored: true } }); // 되돌린 쿠폰은 안 쓴 것으로
    await order(a, IN, 40_000);
    await order(a, IN, 99_000, { paid: false }); // 결제 전은 뺌
    await order(a, "2026-10-09T03:00:00Z", 50_000, { coupon: { id: c1.id, discount: 2_000 } }); // 기간 밖
    await order(other, IN, 70_000, { coupon: { id: oc.id, discount: 2_000 } }); // 다른 쇼핑몰

    const owner = await createSellerUser(a.seller.id, "OWNER");
    const res = await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withCoupon).toEqual({ orders: 2, revenue: 25_000, averageOrderValue: 12_500, discount: 4_000 });
    expect(body.withoutCoupon).toEqual({ orders: 2, revenue: 70_000, averageOrderValue: 35_000 });
    expect(body.useRate).toBe(0.5);
    expect(body.coupons).toEqual([{ couponId: c1.id, name: "첫 구매", benefit: "AMOUNT", uses: 2, discount: 4_000, revenue: 25_000, averageOrderValue: 12_500 }]);
  });

  it("쿠폰 쓴 주문이 없으면 비교는 안 쓴 쪽만, 주문이 전혀 없으면 비율·객단가는 null", async () => {
    const a = await createSeller();
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const empty = await (await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner))).json();
    expect(empty).toMatchObject({ withCoupon: { orders: 0, revenue: 0, averageOrderValue: null, discount: 0 }, withoutCoupon: { orders: 0, averageOrderValue: null }, useRate: null, coupons: [] });
    await order(a, "2026-10-02T03:00:00Z", 10_000);
    const only = await (await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner))).json();
    expect(only).toMatchObject({ withCoupon: { orders: 0 }, withoutCoupon: { orders: 1, revenue: 10_000, averageOrderValue: 10_000 }, useRate: 0 });
  });

  it("쿠폰별 목록은 사용 건수 많은 순 10개까지다", async () => {
    const a = await createSeller();
    const owner = await createSellerUser(a.seller.id, "OWNER");
    for (let i = 0; i < 12; i++) {
      const c = await coupon(a, `CODE${String(i).padStart(4, "0")}`, `쿠폰${i}`);
      for (let k = 0; k <= i; k++) await order(a, "2026-10-02T03:00:00Z", 1_000, { coupon: { id: c.id, discount: 100 } });
    }
    const body = await (await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner))).json();
    expect(body.coupons).toHaveLength(10);
    expect(body.coupons.map((c: { uses: number }) => c.uses)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("통계 권한이 있는 직원만 보고, 잘못된 기간은 400, 로그인 없음은 401", async () => {
    const a = await createSeller();
    const q = "from=2026-10-01&to=2026-10-07";
    const withPerm = await createSellerUser(a.seller.id, { permissions: ["SALES_VIEW"] });
    const without = await createSellerUser(a.seller.id, { permissions: ["INQUIRY_REPLY"] });
    expect((await get(q, await cookieOf(a, withPerm))).status).toBe(200);
    expect((await get(q, await cookieOf(a, without))).status).toBe(403);
    expect((await get("from=2026-10-07&to=2026-10-01", await cookieOf(a, withPerm))).status).toBe(400);
    expect((await get(q)).status).toBe(401);
  });
});
