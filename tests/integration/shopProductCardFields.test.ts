import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { prisma } from "../../lib/server/db";
import { createLoginBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

// 상품 카드 필드(rating·reviewCount·reward): 공개 리뷰만 집계, 판매자 격리, 기본 등급 적립 예정
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const list = async (slug: string) => {
  const res = await listRoute(new Request(`http://localhost:3000/api/shop/${slug}/products`), { params: Promise.resolve({ slug }) });
  return { status: res.status, products: ((await res.json()) as { products: any[] }).products };
};

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const base = await createPaidOrderItem(seller.id, buyer.id);
  return { seller, grade, buyer, product: base.product, option: base.option, firstItem: base.item, firstOrder: base.order };
}
type Shop = Awaited<ReturnType<typeof shop>>;

// 같은 상품에 리뷰를 하나 더 단다(주문 상품마다 리뷰 1개라 주문 상품을 새로 만든다)
async function review(s: Shop, rating: number, extra: Record<string, unknown> = {}, first = false) {
  let orderId = s.firstOrder.id;
  let orderItemId = s.firstItem.id;
  if (!first) {
    const order = await db.order.create({ data: { sellerId: s.seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: s.buyer.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 5000, paidAt: new Date() } });
    const item = await db.orderItem.create({ data: { sellerId: s.seller.id, orderId: order.id, productId: s.product.id, optionId: s.option.id, productNameSnapshot: "x", optionNameSnapshot: "y", unitPrice: 5000, quantity: 1 } });
    orderId = order.id;
    orderItemId = item.id;
  }
  return db.productReview.create({ data: { sellerId: s.seller.id, orderId, orderItemId, productId: s.product.id, buyerMemberId: s.buyer.id, authorNickname: "닉", rating, body: "포장이 꼼꼼하고 카드 상태가 정말 좋았어요", ...extra } as never });
}

describe("상품 카드 평점·리뷰 수", () => {
  it("리뷰가 없으면 rating null·reviewCount 0이다", async () => {
    const s = await shop();
    const r = await list(s.seller.slug);
    expect(r.products[0]).toMatchObject({ rating: null, reviewCount: 0 });
  });

  it("공개(VISIBLE) 리뷰만 평균(소수 1자리)·수에 들어가고, 숨김·대기·보류·지운 리뷰는 빠진다", async () => {
    const s = await shop();
    await review(s, 5, { status: "VISIBLE" }, true);
    await review(s, 4, { status: "VISIBLE" });
    await review(s, 4, { status: "VISIBLE" });
    await review(s, 1, { status: "HIDDEN", hiddenReason: "OTHER" });
    await review(s, 1, { status: "PENDING" });
    await review(s, 1, { status: "HELD" });
    await review(s, 1, { status: "VISIBLE", deletedAt: new Date(), body: "" });
    const p = (await list(s.seller.slug)).products[0];
    expect(p.reviewCount).toBe(3);
    expect(p.rating).toBe(4.3); // (5+4+4)/3 = 4.333…
  });

  it("다른 판매자의 리뷰는 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await review(b, 1, { status: "VISIBLE" }, true);
    expect((await list(a.seller.slug)).products[0]).toMatchObject({ rating: null, reviewCount: 0 });
    expect((await list(b.seller.slug)).products[0]).toMatchObject({ rating: 1, reviewCount: 1 });
  });
});

describe("상품 카드 적립 예정", () => {
  it("적립 정책이 없으면 reward null이다", async () => {
    const s = await shop();
    expect((await list(s.seller.slug)).products[0].reward).toBeNull();
  });

  it("기본 등급 적립률로 표시 가격 기준 원 단위 내림 금액을 준다", async () => {
    const s = await shop(); // 5000원
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 1.5, bankTransfer: 3 } } } });
    expect((await list(s.seller.slug)).products[0].reward).toEqual({ card: { rate: 1.5, amount: 75 }, bankTransfer: { rate: 3, amount: 150 } });
    await db.product.update({ where: { id: s.product.id }, data: { price: 999 } });
    expect((await list(s.seller.slug)).products[0].reward.card.amount).toBe(14); // 999 × 1.5% = 14.985 → 14
  });

  it("이벤트 할인 가격 기준이고, 적립 시작 전·적립률 없음·비정상 값이면 null이다", async () => {
    const s = await shop();
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 10 } } } });
    await db.product.update({ where: { id: s.product.id }, data: { eventDiscountType: "RATE", eventDiscountValue: 20, eventStartsAt: new Date(Date.now() - 3600_000), eventEndsAt: new Date(Date.now() + 3600_000) } });
    const p = (await list(s.seller.slug)).products[0];
    expect([p.price, p.salePrice, p.reward.card.amount, p.reward.bankTransfer]).toEqual([5000, 4000, 400, null]);
    await db.rewardPolicy.update({ where: { sellerId: s.seller.id }, data: { earnStartsAt: new Date(Date.now() + 86_400_000) } });
    expect((await list(s.seller.slug)).products[0].reward).toBeNull();
    await db.rewardPolicy.update({ where: { sellerId: s.seller.id }, data: { earnStartsAt: null, rates: { [s.grade.id]: { card: 0 } } } });
    expect((await list(s.seller.slug)).products[0].reward).toBeNull();
    await db.rewardPolicy.update({ where: { sellerId: s.seller.id }, data: { rates: { [s.grade.id]: { card: 150 } } } });
    expect((await list(s.seller.slug)).products[0].reward).toBeNull();
  });
});
