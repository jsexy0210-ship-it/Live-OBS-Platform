import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as reviewsRoute } from "../../app/api/shop/[slug]/products/[productId]/reviews/route";
import { prisma } from "../../lib/server/db";
import { createLoginBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

// 리뷰 요약(상품 상세): 평균·총 수·별점 분포·사진 리뷰 수. 공개 리뷰만, 판매자·상품 격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BODY = "포장이 꼼꼼하고 카드 상태가 정말 좋았어요";

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const base = await createPaidOrderItem(seller.id, buyer.id);
  let first = true;
  // 리뷰를 하나 단다(주문 상품마다 1개라 첫 리뷰 밖에는 주문 상품을 새로 만든다). photos만큼 사진을 붙인다.
  const review = async (rating: number, opts: { status?: string; deletedAt?: Date; hiddenReason?: string; photos?: number; productId?: string } = {}) => {
    let orderId = base.order.id;
    let orderItemId = base.item.id;
    if (!first) {
      const order = await db.order.create({ data: { sellerId: seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: buyer.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 1000, paidAt: new Date() } });
      const item = await db.orderItem.create({ data: { sellerId: seller.id, orderId: order.id, productId: base.product.id, optionId: base.option.id, productNameSnapshot: "x", optionNameSnapshot: "y", unitPrice: 1000, quantity: 1 } });
      orderId = order.id;
      orderItemId = item.id;
    }
    first = false;
    const r = await db.productReview.create({
      data: { sellerId: seller.id, orderId, orderItemId, productId: base.product.id, buyerMemberId: buyer.id, authorNickname: "닉", rating, body: opts.deletedAt ? "" : BODY, status: (opts.status ?? "VISIBLE") as never, hiddenReason: opts.hiddenReason as never, deletedAt: opts.deletedAt },
    });
    for (let i = 0; i < (opts.photos ?? 0); i++) {
      await db.productReviewImage.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, reviewId: r.id, data: Buffer.from("x"), contentType: "image/jpeg", byteSize: 1, width: 10, height: 10, sortOrder: i } });
    }
    return r;
  };
  return { seller, product: base.product, review };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const summary = async (s: Shop, slug = s.seller.slug, productId = s.product.id) => {
  const res = await reviewsRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug, productId }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("리뷰 요약", () => {
  it("리뷰가 없으면 평균 null·0건·사진 0건이다", async () => {
    const s = await shop();
    const r = await summary(s);
    expect(r.body).toMatchObject({ average: null, total: 0, photoCount: 0 });
    expect(r.body.distribution).toEqual([5, 4, 3, 2, 1].map((rating) => ({ rating, count: 0 })));
  });

  it("공개 리뷰의 평균·분포·사진 리뷰 수를 주고, 사진이 여러 장이어도 리뷰 하나로 센다", async () => {
    const s = await shop();
    await s.review(5, { photos: 3 }); // 사진 3장이어도 사진 리뷰 1개
    await s.review(5);
    await s.review(4, { photos: 1 });
    await s.review(2);
    const r = await summary(s);
    expect(r.body).toMatchObject({ total: 4, photoCount: 2, average: 4 });
    expect(r.body.distribution).toEqual([{ rating: 5, count: 2 }, { rating: 4, count: 1 }, { rating: 3, count: 0 }, { rating: 2, count: 1 }, { rating: 1, count: 0 }]);
  });

  it("숨김·대기·보류·지운 리뷰의 사진은 사진 리뷰 수에 들어가지 않는다", async () => {
    const s = await shop();
    await s.review(5, { photos: 1 });
    await s.review(1, { status: "HIDDEN", hiddenReason: "OTHER", photos: 2 });
    await s.review(1, { status: "PENDING", photos: 1 });
    await s.review(1, { status: "HELD", photos: 1 });
    await s.review(1, { deletedAt: new Date() });
    const r = await summary(s);
    expect([r.body.total, r.body.photoCount, r.body.average]).toEqual([1, 1, 5]);
  });

  it("다른 판매자·다른 상품의 리뷰는 섞이지 않고, 보이지 않는 상품·없는 쇼핑몰은 404이다", async () => {
    const a = await shop();
    const b = await shop();
    await b.review(1, { photos: 2 });
    expect(await summary(a)).toMatchObject({ status: 200, body: { total: 0, photoCount: 0 } });
    expect((await summary(a, b.seller.slug)).status).toBe(404); // a 상품을 b 쇼핑몰 주소로 부름
    expect((await summary(a, "no-such-shop")).status).toBe(404);
    await db.product.update({ where: { id: a.product.id }, data: { status: "HIDDEN" } });
    expect((await summary(a)).status).toBe(404);
  });
});
