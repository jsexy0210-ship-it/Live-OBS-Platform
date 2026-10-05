import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/seller/stats/wishlist/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 찜→구매 근사 GET /api/seller/stats/wishlist
beforeEach(resetDb);
afterAll(() => db.$disconnect());

type Shop = Awaited<ReturnType<typeof createSeller>>;
const cookieOf = async (s: Shop, user: Awaited<ReturnType<typeof createSellerUser>>) =>
  `lo_seller=${(await createSellerSession(db, s.seller.id, user.id, {}, user.credentialVersion)).token}`;
const get = (q: string, cookie?: string) => route(new Request(`http://localhost:3000/api/seller/stats/wishlist?${q}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));

const product = (s: Shop, name: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { sellerId: s.seller.id, name, price: 1000, status: "ON_SALE", ...extra } });
const wish = (s: Shop, memberId: string, productId: string, at: string) => db.wishItem.create({ data: { sellerId: s.seller.id, buyerMemberId: memberId, productId, createdAt: new Date(at) } });
async function buy(s: Shop, memberId: string, p: { id: string; name: string }, at: string, status: "PAID" | "REFUNDED" | "CANCELLED" = "PAID") {
  const o = await db.productOption.create({ data: { sellerId: s.seller.id, productId: p.id, name: "옵션", stock: 5 } });
  const order = await db.order.create({
    data: { sellerId: s.seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: memberId, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status, createdAt: new Date(at), paidAt: status === "CANCELLED" ? null : new Date(at) } as never,
  });
  await db.orderItem.create({ data: { sellerId: s.seller.id, orderId: order.id, productId: p.id, optionId: o.id, productNameSnapshot: p.name, optionNameSnapshot: "옵션", unitPrice: 1000, quantity: 1 } });
}

describe("찜→구매 근사", () => {
  it("기간에 찜한 상품을 같은 회원이 찜 뒤에 결제한 비율과 상품별 상위를 준다", async () => {
    const a = await createSeller();
    const other = await createSeller();
    const [m1, m2, m3, m4] = await Promise.all([1, 2, 3, 4].map(() => createBuyer(a.seller.id, a.grade.id)));
    const p1 = await product(a, "상품1");
    const p2 = await product(a, "상품2");
    const p3 = await product(a, "지운 상품", { deletedAt: new Date() });
    const W = "2026-10-02T03:00:00Z";
    await wish(a, m1.id, p1.id, W);
    await wish(a, m2.id, p1.id, W);
    await wish(a, m3.id, p1.id, W);
    await wish(a, m1.id, p2.id, W);
    await wish(a, m4.id, p2.id, W);
    await wish(a, m1.id, p3.id, W); // 지운 상품은 뺌
    await wish(a, m2.id, p2.id, "2026-10-20T03:00:00Z"); // 기간 밖
    await buy(a, m1.id, p1, "2026-10-03T03:00:00Z"); // 찜 뒤 결제 → 산 것
    await buy(a, m2.id, p1, "2026-10-01T03:00:00Z"); // 찜 전에 샀음 → 아님
    await buy(a, m3.id, p1, "2026-10-03T03:00:00Z", "REFUNDED"); // 환불 → 아님
    await buy(a, m1.id, p2, "2026-10-03T03:00:00Z", "CANCELLED"); // 취소 → 아님
    await buy(a, m4.id, p2, "2026-10-04T03:00:00Z"); // 찜 뒤 결제 → 산 것
    const om = await createBuyer(other.seller.id, other.grade.id);
    await wish(other, om.id, (await product(other, "남의 상품")).id, W); // 다른 쇼핑몰

    const owner = await createSellerUser(a.seller.id, "OWNER");
    const res = await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ approximate: true, wishes: 5, bought: 2, rate: 0.4 });
    expect(body.products).toEqual([
      { productId: p1.id, name: "상품1", wishes: 3, bought: 1, rate: 0.3333 },
      { productId: p2.id, name: "상품2", wishes: 2, bought: 1, rate: 0.5 },
    ]);
  });

  it("찜이 없으면 비율은 null이고 상품별은 10개까지다", async () => {
    const a = await createSeller();
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const empty = await (await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner))).json();
    expect(empty).toMatchObject({ wishes: 0, bought: 0, rate: null, products: [] });
    const m = await createBuyer(a.seller.id, a.grade.id);
    for (let i = 0; i < 12; i++) await wish(a, m.id, (await product(a, `상품${i}`)).id, "2026-10-02T03:00:00Z");
    const body = await (await get("from=2026-10-01&to=2026-10-07", await cookieOf(a, owner))).json();
    expect(body.wishes).toBe(12);
    expect(body.products).toHaveLength(10);
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
