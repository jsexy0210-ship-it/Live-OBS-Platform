import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/shop/[slug]/products/[productId]/route";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { setProductDetail } from "../../lib/server/products/detail";
import { uploadProductImage } from "../../lib/server/products/images";
import { createProduct } from "../../lib/server/products/manage";
import { markOrderPaid } from "../../lib/server/queue/service";
import { createCategory, setProductCategories, updateCategory } from "../../lib/server/shop-category/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 구매자 상품 목록·상세 API: 보이는 상품만, 카테고리·정렬, 사진·옵션·상세 블록·배송비·적립 예정
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
async function made(ctx: TenantContext, body: Record<string, unknown>) {
  const r = await createProduct(db, ctx, { price: 1000, status: "ON_SALE", options: [{ name: "1박스", stock: 10 }], ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const list = async (slug: string, qs = "") => {
  const res = await listRoute(new Request(`http://localhost:3000/api/shop/${slug}/products?${qs}`), { params: Promise.resolve({ slug }) });
  return { status: res.status, body: await res.json() };
};
const detail = async (slug: string, productId: string, cookie?: string) => {
  const res = await detailRoute(new Request("http://localhost:3000/x", { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ slug, productId }) });
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
};

describe("구매자 상품 목록", () => {
  it("보이는 상품(판매 중·품절)만, 카테고리(하위 포함)·검색·정렬·쪽 나누기, 다른 쇼핑몰은 섞이지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const a = await made(s.ctx, { name: "포켓몬 팩", price: 3000, sortOrder: 2 });
    const b = await made(s.ctx, { name: "유희왕 팩", price: 1000, sortOrder: 1, status: "SOLD_OUT" });
    const c = await made(s.ctx, { name: "포켓몬 박스", price: 5000, sortOrder: 3, options: [{ name: "o", stock: 0 }] });
    await made(s.ctx, { name: "숨긴 상품", status: "HIDDEN" });
    await made(s.ctx, { name: "대기 상품", status: "DRAFT", options: [] });
    await made(other.ctx, { name: "남의 포켓몬" });
    await db.product.update({ where: { id: a.id }, data: { createdAt: new Date("2026-01-03T00:00:00Z") } });
    await db.product.update({ where: { id: b.id }, data: { createdAt: new Date("2026-01-02T00:00:00Z") } });
    await db.product.update({ where: { id: c.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    await uploadProductImage(db, s.ctx, a.id, png(200, 200));

    const all = await list(s.seller.slug);
    expect(all.status).toBe(200);
    expect(all.body.products.map((p: { name: string }) => p.name)).toEqual(["포켓몬 팩", "유희왕 팩", "포켓몬 박스"]);
    expect(all.body.products[0]).toMatchObject({ code: "P0000001", price: 3000, salePrice: null, soldOut: false, thumbnailUrl: expect.stringContaining(`/api/shop/${s.seller.slug}/products/${a.id}/images/`) });
    expect(all.body.products.map((p: { soldOut: boolean }) => p.soldOut)).toEqual([false, true, true]); // 품절 상태·재고 0
    expect(all.body).toMatchObject({ total: 3, page: 1, hasMore: false });

    const names = async (qs: string) => (await list(s.seller.slug, qs)).body.products.map((p: { name: string }) => p.name);
    expect(await names("sort=low")).toEqual(["유희왕 팩", "포켓몬 팩", "포켓몬 박스"]);
    expect(await names("sort=high")).toEqual(["포켓몬 박스", "포켓몬 팩", "유희왕 팩"]);
    expect(await names("sort=recommended")).toEqual(["유희왕 팩", "포켓몬 팩", "포켓몬 박스"]);
    expect(await names("q=포켓몬")).toEqual(["포켓몬 팩", "포켓몬 박스"]);
    const p2 = await list(s.seller.slug, "limit=2&page=2");
    expect(p2.body).toMatchObject({ total: 3, page: 2, hasMore: false });
    expect(p2.body.products.map((p: { name: string }) => p.name)).toEqual(["포켓몬 박스"]);

    // 판매량순: 결제 완료 수량만
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: a.options[0].id, quantity: 2 }], consent, shippingAddress });
    if (!o.ok) throw new Error(o.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" });
    expect((await names("sort=popular"))[0]).toBe("포켓몬 팩");

    // 카테고리: 대분류는 하위 포함, 꺼진 카테고리는 404
    const top = await createCategory(db, s.ctx, { name: "카드" });
    if (!top.ok) throw new Error(top.reason);
    const sub = await createCategory(db, s.ctx, { name: "포켓몬", parentId: top.value[0].id });
    if (!sub.ok) throw new Error(sub.reason);
    const subId = sub.value[0].children[0].id;
    await setProductCategories(db, s.ctx, a.id, { categoryIds: [subId] });
    await setProductCategories(db, s.ctx, b.id, { categoryIds: [top.value[0].id] });
    expect(await names(`categoryId=${top.value[0].id}`)).toEqual(["포켓몬 팩", "유희왕 팩"]);
    expect(await names(`categoryId=${subId}`)).toEqual(["포켓몬 팩"]);
    await updateCategory(db, s.ctx, top.value[0].id, { visible: false });
    expect((await list(s.seller.slug, `categoryId=${subId}`)).status).toBe(404); // 대분류가 꺼지면 하위도
    const othersCat = await createCategory(db, other.ctx, { name: "남의 것" });
    if (!othersCat.ok) throw new Error(othersCat.reason);
    expect((await list(s.seller.slug, `categoryId=${othersCat.value[0].id}`)).status).toBe(404);

    for (const qs of ["sort=price", "page=0", "limit=61", "limit=x", "categoryId=nope", "q=" + "가".repeat(51)]) {
      const r = await list(s.seller.slug, qs);
      expect(r.status, qs).toBe(400);
      expect(r.body).toEqual({ error: "invalid_query", message: ORDER_ERROR_MESSAGES.invalid_query });
    }
    expect((await list("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await list(s.seller.slug)).status).toBe(404);
  });
});

describe("구매자 상품 상세", () => {
  it("배송·환불 안내는 판매자 설정을 쓰고 찜 총수에는 다른 상품·판매자를 섞지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const p = await made(s.ctx, { name: "찜 집계 상품" });
    const another = await made(s.ctx, { name: "별도 상품" });
    const foreign = await made(other.ctx, { name: "다른 판매자 상품" });
    const a = await createLoginBuyer(s.seller.id, s.grade.id);
    const b = await createLoginBuyer(s.seller.id, s.grade.id);
    const c = await createLoginBuyer(other.seller.id, other.grade.id);
    await db.wishItem.createMany({ data: [
      { sellerId: s.seller.id, buyerMemberId: a.id, productId: p.id },
      { sellerId: s.seller.id, buyerMemberId: b.id, productId: p.id },
      { sellerId: s.seller.id, buyerMemberId: a.id, productId: another.id },
      { sellerId: other.seller.id, buyerMemberId: c.id, productId: foreign.id },
    ] });
    await db.sellerShippingPolicy.create({ data: { sellerId: s.seller.id, returnFee: 4500, exchangeFee: 9000, dispatchDeadlineDays: 5 } });
    const result = await detail(s.seller.slug, p.id);
    expect(result.body.product).toMatchObject({ wishCount: 2, shipping: { receiveMethods: ["IMMEDIATE"], returnFee: 4500, exchangeFee: 9000, dispatchDeadlineDays: 5 }, openingNotice: OPENED_NO_REFUND_CONSENT.text });
    expect((await detail(other.seller.slug, p.id)).status).toBe(404);
  });
  it("사진·옵션(할인가·품절·적을 때 남은 수)·상세 블록·카테고리·배송비·적립 예정을 주고, 보이지 않는 상품은 404", async () => {
    const s = await seller();
    const p = await made(s.ctx, {
      name: "포켓몬 팩",
      price: 10000,
      description: "설명",
      options: [
        { name: "1팩", stock: 3 },
        { name: "1박스", priceDelta: 5000, stock: 50 },
        { name: "한정", priceDelta: 1000, stock: 0 },
      ],
    });
    // 이벤트 할인 10%
    await db.product.update({
      where: { id: p.id },
      data: { eventDiscountType: "RATE", eventDiscountValue: 10, eventStartsAt: new Date(Date.now() - 3600_000), eventEndsAt: new Date(Date.now() + 86400_000) },
    });
    const img = await uploadProductImage(db, s.ctx, p.id, png(300, 300));
    const dimg = await uploadProductImage(db, s.ctx, p.id, png(400, 300), {}, "DETAIL");
    if (!img.ok || !dimg.ok) throw new Error("upload");
    await setProductDetail(db, s.ctx, p.id, { blocks: [{ type: "text", text: "개봉 안내" }, { type: "image", imageId: dimg.image.id }] });
    const cat = await createCategory(db, s.ctx, { name: "카드" });
    if (!cat.ok) throw new Error(cat.reason);
    await setProductCategories(db, s.ctx, p.id, { categoryIds: [cat.value[0].id] });
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 1, bankTransfer: 3 } } } });

    const r = await detail(s.seller.slug, p.id);
    expect(r.status).toBe(200);
    expect(r.cache).toContain("no-store");
    const d = r.body.product;
    expect(d).toMatchObject({ id: p.id, code: "P0000001", name: "포켓몬 팩", description: "설명", price: 10000, salePrice: 9000, event: { endsAt: expect.any(String) }, soldOut: false });
    expect(d.eventEnded).toBe(false);
    expect(d.images).toEqual([{ id: img.image.id, url: expect.stringMatching(new RegExp(`^/api/shop/${s.seller.slug}/products/${p.id}/images/${img.image.id}\\?v=`)), width: 300, height: 300 }]);
    expect(d.options.map((o: Record<string, unknown>) => [o.name, o.price, o.salePrice, o.soldOut, o.stockLeft])).toEqual([
      ["1팩", 10000, 9000, false, 3],
      ["1박스", 15000, 13500, false, null],
      ["한정", 11000, 9900, true, null],
    ]);
    expect(d.detail).toEqual([
      { type: "text", text: "개봉 안내" },
      { type: "image", imageId: dimg.image.id, url: expect.stringContaining(`/api/shop/${s.seller.slug}/`), width: 400, height: 300 },
    ]);
    expect(d.categories).toEqual([{ id: cat.value[0].id, name: "카드" }]);
    expect(Object.keys(d.shipping).sort()).toEqual(["baseFee", "dispatchDeadlineDays", "exchangeFee", "freeOverAmount", "freeShipping", "receiveMethods", "remoteSurcharge", "returnFee"]); // 도서산간 우편번호 표·판매자 전용 기본 택배사는 내보내지 않음
    expect(d.shipping).toMatchObject({ freeShipping: false, baseFee: expect.any(Number) });
    expect(d.shipping).toMatchObject({ receiveMethods: ["IMMEDIATE"], dispatchDeadlineDays: 3, returnFee: 3000, exchangeFee: 6000 });
    expect(d.openingNotice).toBe(OPENED_NO_REFUND_CONSENT.text);
    expect(d.wishCount).toBe(0);
    expect(d.broadcast).toBeNull();
    expect(d.reward).toEqual({ card: { rate: 1, amount: 90 }, bankTransfer: { rate: 3, amount: 270 } });

    // 로그인 회원은 그 등급의 적립률
    const vip = await db.memberGrade.create({ data: { sellerId: s.seller.id, displayName: "VIP", sortOrder: 9 } });
    await db.rewardPolicy.update({ where: { sellerId: s.seller.id }, data: { rates: { [s.grade.id]: { card: 1 }, [vip.id]: { card: 5 } } } });
    const buyer = await createLoginBuyer(s.seller.id, vip.id);
    const login = await loginBuyer(db, { sellerId: s.seller.id, loginId: buyer.loginId!, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await detail(s.seller.slug, p.id, `lo_buyer=${login.token}`)).body.product.reward).toEqual({ card: { rate: 5, amount: 450 }, bankTransfer: null });
    expect((await detail(s.seller.slug, p.id)).body.product.reward).toEqual({ card: { rate: 1, amount: 90 }, bankTransfer: null });

    await db.product.update({ where: { id: p.id }, data: { eventStartsAt: new Date(Date.now() - 60_000), eventEndsAt: new Date(Date.now() - 1_000) } });
    expect((await detail(s.seller.slug, p.id)).body.product).toMatchObject({ salePrice: null, event: null, eventEnded: true });

    // 보이지 않는 상품·다른 쇼핑몰·없는 id는 404
    const other = await seller();
    expect((await detail(other.seller.slug, p.id)).status).toBe(404);
    expect((await detail(s.seller.slug, "nope")).status).toBe(404);
    for (const status of ["HIDDEN", "DRAFT"] as const) {
      await db.product.update({ where: { id: p.id }, data: { status } });
      expect((await detail(s.seller.slug, p.id)).status, status).toBe(404);
    }
    await db.product.update({ where: { id: p.id }, data: { status: "SOLD_OUT" } });
    const so = (await detail(s.seller.slug, p.id)).body.product;
    expect(so.soldOut).toBe(true);
    expect(so.options.every((o: { soldOut: boolean; stockLeft: number | null }) => o.soldOut && o.stockLeft === null)).toBe(true);
    await db.product.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    expect((await detail(s.seller.slug, p.id)).status).toBe(404);
  });
});
