import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as recRoute } from "../../app/api/shop/[slug]/products/[productId]/recommendations/route";
import { prisma } from "../../lib/server/db";
import { createProduct } from "../../lib/server/products/manage";
import { createCategory, setProductCategories } from "../../lib/server/shop-category/service";
import { setRecommended } from "../../lib/server/shop-display/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 추천 상품(상품 상세, AI 없음): 운영자 지정 → 같은 카테고리 판매량·최신 → 전체 판매량 → 전체 최신, 자기 자신·남의 쇼핑몰·숨긴 상품 제외, 품절 뒤로
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  let n = 0;
  const make = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 10 }], ...extra });
    if (!r.ok) throw new Error(r.reason);
    // 최신순이 이름 순서를 따르도록 등록 시각을 벌려 둔다
    await db.product.update({ where: { id: r.value.id }, data: { createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + n++ * 60_000) } });
    return r.value;
  };
  // 결제 완료 판매(수량): 주문 상품을 직접 만든다
  const sell = async (productId: string, optionId: string, quantity: number, paidAt = new Date()) => {
    const order = await db.order.create({ data: { sellerId: seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: buyer.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 1000, paidAt } });
    await db.orderItem.create({ data: { sellerId: seller.id, orderId: order.id, productId, optionId, productNameSnapshot: "x", optionNameSnapshot: "y", unitPrice: 1000, quantity } });
  };
  const category = async (name: string) => {
    const c = await createCategory(db, ctx, { name });
    if (!c.ok) throw new Error(c.reason);
    return c.value.find((x: { name: string }) => x.name === name)!.id as string;
  };
  return { seller, ctx, make, sell, category };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const rec = async (slug: string, productId: string, qs = "") => {
  const res = await recRoute(new Request(`http://localhost:3000/x${qs}`), { params: Promise.resolve({ slug, productId }) });
  return { status: res.status, body: (await res.json()) as { products?: any[]; error?: string } };
};
const names = (r: { body: { products?: any[] } }) => r.body.products!.map((p) => p.name);
const reasons = (r: { body: { products?: any[] } }) => r.body.products!.map((p) => p.reason);
const inCategory = (s: Shop, categoryId: string, ...p: { id: string }[]) => Promise.all(p.map((x) => setProductCategories(db, s.ctx, x.id, { categoryIds: [categoryId] })));

describe("추천 상품", () => {
  it("운영자 지정 → 같은 카테고리(판매량 → 최신) → 전체 판매량 → 전체 최신 순서이고, 자기 자신은 없으며 중복이 없다", async () => {
    const s = await shop();
    const me = await s.make("기준");
    const c1 = await s.make("같은카테고리-팔림");
    const c2 = await s.make("같은카테고리-신상");
    const c3 = await s.make("같은카테고리-구상");
    const pick = await s.make("운영자지정");
    const bestOther = await s.make("다른카테고리-베스트");
    const newOther = await s.make("다른카테고리-신상");
    const cat = await s.category("카드");
    await inCategory(s, cat, me, c1, c2, c3);
    await s.sell(c3.id, c3.options[0].id, 1); // 같은 카테고리에서는 판매가 있는 상품이 앞
    await s.sell(c1.id, c1.options[0].id, 5);
    await s.sell(bestOther.id, bestOther.options[0].id, 9);
    await setRecommended(db, s.ctx, { productIds: [pick.id, me.id] }); // 자기 자신 지정은 걸러진다
    const r = await rec(s.seller.slug, me.id);
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(["운영자지정", "같은카테고리-팔림", "같은카테고리-구상", "같은카테고리-신상", "다른카테고리-베스트", "다른카테고리-신상"]);
    expect(reasons(r)).toEqual(["pick", "category", "category", "category", "best", "new"]);
    expect(new Set(r.body.products!.map((p) => p.id)).size).toBe(r.body.products!.length);
    expect(r.body.products!.some((p) => p.id === me.id)).toBe(false);
    expect(newOther.id).toBeTruthy();
  });

  it("limit으로 개수를 줄이고(1~20), 틀린 값은 400이다", async () => {
    const s = await shop();
    const me = await s.make("기준");
    for (let i = 0; i < 5; i++) await s.make(`상품${i}`);
    expect((await rec(s.seller.slug, me.id, "?limit=2")).body.products).toHaveLength(2);
    expect((await rec(s.seller.slug, me.id)).body.products).toHaveLength(5);
    for (const bad of ["0", "21", "x", "-1"]) expect((await rec(s.seller.slug, me.id, `?limit=${bad}`)).status).toBe(400);
  });

  it("숨김·초안·삭제 상품과 다른 판매자 상품은 나오지 않고, 품절은 뒤로 가며 품절 숨기기를 켜면 빠진다", async () => {
    const s = await shop();
    const other = await shop();
    const me = await s.make("기준");
    const soldOut = await s.make("품절", { status: "SOLD_OUT" });
    await s.make("숨김", { status: "HIDDEN" });
    await s.make("초안", { status: "DRAFT", options: [] });
    const gone = await s.make("삭제");
    await db.product.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await s.make("정상1");
    await s.make("정상2");
    await other.make("남의상품");
    const r = await rec(s.seller.slug, me.id);
    expect(names(r)).toEqual(["정상2", "정상1", "품절"]); // 최신순, 품절은 맨 뒤
    expect(r.body.products!.at(-1).id).toBe(soldOut.id);
    await db.shopDisplaySetting.create({ data: { sellerId: s.seller.id, hideSoldOut: true } });
    expect(names(await rec(s.seller.slug, me.id))).toEqual(["정상2", "정상1"]);
  });

  it("최근 30일 밖의 판매·취소 주문은 판매량에 넣지 않는다", async () => {
    const s = await shop();
    const me = await s.make("기준");
    const old = await s.make("오래전 베스트");
    const hot = await s.make("요즘 베스트");
    await s.sell(old.id, old.options[0].id, 50, new Date(Date.now() - 40 * 86_400_000));
    await s.sell(hot.id, hot.options[0].id, 1);
    expect(names(await rec(s.seller.slug, me.id))).toEqual(["요즘 베스트", "오래전 베스트"]);
    expect(reasons(await rec(s.seller.slug, me.id))).toEqual(["best", "new"]);
  });

  it("카드에 평점·리뷰 수·적립 예정 필드가 있고, 다른 쇼핑몰 슬러그·보이지 않는 기준 상품·잘못된 id는 404이다", async () => {
    const s = await shop();
    const other = await shop();
    const me = await s.make("기준");
    await s.make("다른 상품");
    const hidden = await s.make("숨김 기준", { status: "HIDDEN" });
    const r = await rec(s.seller.slug, me.id);
    expect(r.body.products![0]).toMatchObject({ rating: null, reviewCount: 0, reward: null, reason: "new" });
    expect((await rec(other.seller.slug, me.id)).status).toBe(404);
    expect((await rec(s.seller.slug, hidden.id)).status).toBe(404);
    expect((await rec(s.seller.slug, "nope")).status).toBe(404);
    expect((await rec("no-such-shop", me.id)).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await rec(s.seller.slug, me.id)).status).toBe(404);
  });
});
