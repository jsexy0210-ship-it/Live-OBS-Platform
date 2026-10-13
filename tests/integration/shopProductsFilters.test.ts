import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { createProduct } from "../../lib/server/products/manage";
import { markOrderPaid } from "../../lib/server/queue/service";
import { createCategory, setProductCategories } from "../../lib/server/shop-category/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SH-002 필터 시트·관련도순: sort=relevance, inStock, live, minPrice·maxPrice, 여러 카테고리(AND), 카드 값(별점·리뷰 수·적립 예정).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function seller() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, ctx };
}
type S = Awaited<ReturnType<typeof seller>>;
async function made(ctx: TenantContext, body: Record<string, unknown>) {
  const r = await createProduct(db, ctx, { price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 10 }], ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const get = async (slug: string, qs = "") => {
  const res = await listRoute(new Request(`http://localhost:3000/api/shop/${slug}/products?${qs}`), { params: Promise.resolve({ slug }) });
  return { status: res.status, body: await res.json() };
};
const names = async (s: S, qs: string) => (await get(s.seller.slug, qs)).body.products.map((p: { name: string }) => p.name);

describe("상품 목록 필터·관련도 (SH-002)", () => {
  it("관련도순: 이름 일치 > 이름 시작 > 이름 포함 > 태그, 유사어는 아래, 같은 점수면 품절은 뒤. 검색어 없으면 기본 정렬", async () => {
    const s = await seller();
    await made(s.ctx, { name: "스타라이트 부스터 박스" }); // 포함
    await made(s.ctx, { name: "부스터" }); // 일치
    await made(s.ctx, { name: "부스터 팩 5종" }); // 시작
    await made(s.ctx, { name: "카드 슬리브", searchTags: ["부스터"] }); // 태그 일치
    await made(s.ctx, { name: "부스터 소프트", status: "SOLD_OUT" }); // 시작(품절)
    await made(s.ctx, { name: "무관한 상품" });
    await db.shopSearchSynonym.create({ data: { sellerId: s.seller.id, words: ["부스터", "부스트"] } });
    await made(s.ctx, { name: "부스트 팩" }); // 유사어로만 찾음(시작이지만 원래 검색어로 찾은 상품보다 아래)
    const rel = await names(s, `q=${encodeURIComponent("부스터")}&sort=relevance`);
    expect(rel).toEqual(["부스터", "부스터 팩 5종", "부스터 소프트", "스타라이트 부스터 박스", "카드 슬리브", "부스트 팩"].filter((n) => rel.includes(n)));
    expect(rel).not.toContain("무관한 상품");
    expect(rel.indexOf("부스터 팩 5종")).toBeLessThan(rel.indexOf("부스터 소프트")); // 같은 점수면 품절은 뒤
    expect(rel.indexOf("부스트 팩")).toBe(rel.length - 1); // 유사어로만 찾은 상품은 맨 아래 단계
    // q 없이 relevance는 오류 없이 기본 정렬
    const noQ = await get(s.seller.slug, "sort=relevance");
    expect(noQ.status).toBe(200);
    expect(noQ.body.total).toBe(7);
  });

  it("재고 있는 상품만·방송 중 상품만·가격 범위(표시 가격)를 합쳐도 total·쪽 나누기가 맞다", async () => {
    const s = await seller();
    const a = await made(s.ctx, { name: "A", price: 1000 });
    await made(s.ctx, { name: "B", price: 5000, status: "SOLD_OUT" });
    await made(s.ctx, { name: "C", price: 3000, options: [{ name: "o", stock: 0 }] });
    const d = await made(s.ctx, { name: "D", price: 9000 });
    await made(s.ctx, { name: "E", price: 2000 });
    expect(await names(s, "inStock=1&sort=low")).toEqual(["A", "E", "D"]);
    expect(await names(s, "inStock=0&sort=low")).toEqual(["A", "E", "C", "B", "D"]);
    expect(await names(s, "minPrice=2000&maxPrice=5000&sort=low")).toEqual(["E", "C", "B"]);
    expect(await names(s, "minPrice=2000&maxPrice=5000&inStock=true&sort=low")).toEqual(["E"]);
    expect(await names(s, "maxPrice=1000")).toEqual(["A"]);
    expect(await names(s, "minPrice=9000")).toEqual(["D"]);
    expect(await names(s, "minPrice=5000&maxPrice=5000")).toEqual(["B"]);
    const page = await get(s.seller.slug, "inStock=1&sort=low&limit=2&page=2");
    expect(page.body).toMatchObject({ total: 3, page: 2, hasMore: false });
    expect(page.body.products.map((p: { name: string }) => p.name)).toEqual(["D"]);
    // 방송 중: 지금 LIVE 방송의 대기열에 있는 상품만
    expect(await names(s, "live=1")).toEqual([]);
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: d.options[0].id, quantity: 1 }], consent, shippingAddress });
    if (!o.ok) throw new Error(o.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" });
    const session = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", title: "방송" } });
    const q = await db.queueItem.findFirstOrThrow({ where: { sellerId: s.seller.id, orderId: o.orderId } });
    await db.queueItem.update({ where: { id: q.id }, data: { broadcastSessionId: session.id } });
    const live = await get(s.seller.slug, "live=1");
    expect(live.body.products.map((p: { name: string; isLive: boolean }) => [p.name, p.isLive])).toEqual([["D", true]]);
    expect(await names(s, `live=1&maxPrice=5000`)).toEqual([]);
    expect(a.id).toBeTruthy();
  });

  it("여러 카테고리(게임 + 형태)는 모두에 속한 상품만, 하위 포함, 첫 값만 쓰던 기존 호출도 그대로", async () => {
    const s = await seller();
    const game = await createCategory(db, s.ctx, { name: "게임" });
    const form = await createCategory(db, s.ctx, { name: "형태" });
    if (!game.ok || !form.ok) throw new Error("category");
    const gameId = game.value.find((c) => c.name === "게임")!.id;
    const formId = form.value.find((c) => c.name === "형태")!.id;
    const poke = await createCategory(db, s.ctx, { name: "포켓몬", parentId: gameId });
    const op = await createCategory(db, s.ctx, { name: "원피스", parentId: gameId });
    const box = await createCategory(db, s.ctx, { name: "부스터 박스", parentId: formId });
    const single = await createCategory(db, s.ctx, { name: "싱글 카드", parentId: formId });
    if (!poke.ok || !op.ok || !box.ok || !single.ok) throw new Error("sub");
    const child = (r: typeof poke, parent: string, name: string) => r.value.find((c) => c.id === parent)!.children.find((c) => c.name === name)!.id;
    const pokeId = child(poke, gameId, "포켓몬");
    const opId = child(op, gameId, "원피스");
    const boxId = child(box, formId, "부스터 박스");
    const singleId = child(single, formId, "싱글 카드");
    const p1 = await made(s.ctx, { name: "포켓몬 박스" });
    const p2 = await made(s.ctx, { name: "포켓몬 싱글" });
    const p3 = await made(s.ctx, { name: "원피스 박스" });
    await setProductCategories(db, s.ctx, p1.id, { categoryIds: [pokeId, boxId] });
    await setProductCategories(db, s.ctx, p2.id, { categoryIds: [pokeId, singleId] });
    await setProductCategories(db, s.ctx, p3.id, { categoryIds: [opId, boxId] });
    const sorted = async (qs: string) => (await names(s, qs)).sort();
    expect(await sorted(`categoryId=${pokeId}`)).toEqual(["포켓몬 박스", "포켓몬 싱글"]);
    expect(await sorted(`categoryId=${pokeId},${boxId}`)).toEqual(["포켓몬 박스"]);
    expect(await sorted(`categoryId=${pokeId}&categoryId=${boxId}`)).toEqual(["포켓몬 박스"]);
    expect(await sorted(`categoryId=${gameId},${boxId}`)).toEqual(["원피스 박스", "포켓몬 박스"]); // 대분류는 하위 포함
    expect(await sorted(`categoryId=${opId},${singleId}`)).toEqual([]);
    const other = await seller();
    const foreign = await createCategory(db, other.ctx, { name: "남의 것" });
    if (!foreign.ok) throw new Error("foreign");
    expect((await get(s.seller.slug, `categoryId=${pokeId},${foreign.value[0].id}`)).status).toBe(404);
    expect((await get(s.seller.slug, `categoryId=${pokeId},nope`)).status).toBe(400);
    expect((await get(s.seller.slug, `categoryId=${Array(6).fill(pokeId).join(",")}`)).status).toBe(400);
  });

  it("잘못된 값은 400, 카드에는 별점·리뷰 수·적립 예정이 있다", async () => {
    const s = await seller();
    await made(s.ctx, { name: "상품", price: 100000 });
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 1, bankTransfer: 2 } } } });
    for (const qs of ["minPrice=-1", "minPrice=x", "maxPrice=1.5", "minPrice=3000&maxPrice=2000", "minPrice=100000001", "inStock=yes", "live=2", "coupon=yes", "sort=best"]) {
      expect((await get(s.seller.slug, qs)).status, qs).toBe(400);
    }
    const r = await get(s.seller.slug);
    expect(r.body.products[0]).toMatchObject({ rating: null, reviewCount: 0, isLive: false, reward: { card: { rate: 1, amount: 1000 }, bankTransfer: { rate: 2, amount: 2000 } } });
  });

  it("판매자의 발급 중 쿠폰 상품 범위·기간·이벤트 할인 제외만 목록에서 판정하고 다른 판매자는 섞지 않는다", async () => {
    const a = await seller();
    const b = await seller();
    const scoped = await made(a.ctx, { name: "대상", price: 5000 });
    await made(a.ctx, { name: "범위 밖", price: 5000 });
    const sale = await made(a.ctx, { name: "행사 상품", price: 5000 });
    const foreign = await made(b.ctx, { name: "다른 판매자", price: 5000 });
    const now = new Date();
    const past = new Date(now.getTime() - 86_400_000);
    const future = new Date(now.getTime() + 86_400_000);
    const later = new Date(now.getTime() + 2 * 86_400_000);
    await db.product.update({ where: { id: sale.id }, data: {
      eventDiscountType: "AMOUNT", eventDiscountValue: 500, eventStartsAt: past, eventEndsAt: future,
    } });
    const addCoupon = (sellerId: string, name: string, productIds: string[], options: {
      startsAt?: Date; endsAt?: Date; isActive?: boolean; excludeDiscounted?: boolean;
    } = {}) => db.coupon.create({ data: {
      sellerId, name, issueMethod: "DOWNLOAD", benefit: "AMOUNT", value: 500,
      startsAt: options.startsAt ?? past, endsAt: options.endsAt ?? future,
      productIds, excludeDiscounted: options.excludeDiscounted ?? true, isActive: options.isActive ?? true,
    } });
    await addCoupon(a.seller.id, "선택 상품", [scoped.id]);
    await addCoupon(a.seller.id, "시작 전", [], { startsAt: future, endsAt: later });
    await addCoupon(a.seller.id, "발급 중지", [], { isActive: false });
    await addCoupon(a.seller.id, "기간 종료", [], { startsAt: new Date(past.getTime() - 86_400_000), endsAt: past });
    await addCoupon(b.seller.id, "다른 판매자 전체", []);
    expect(await names(a, "coupon=1&sort=low")).toEqual(["대상"]);
    expect(await names(b, "coupon=1")).toEqual(["다른 판매자"]);
    await addCoupon(a.seller.id, "전체 상품 · 행사 제외", []);
    expect((await names(a, "coupon=1")).sort()).toEqual(["대상", "범위 밖"]);
    await addCoupon(a.seller.id, "행사 포함", [sale.id], { excludeDiscounted: false });
    expect((await names(a, "coupon=1")).sort()).toEqual(["대상", "범위 밖", "행사 상품"]);
    expect((await get(a.seller.slug, "coupon=1&limit=1&page=2")).body).toMatchObject({ total: 3, page: 2, hasMore: true });
    expect(foreign.id).toBeTruthy();
  });
});
