import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as publicGet } from "../../app/api/shop/[slug]/products/[productId]/inquiries/route";
import { prisma } from "../../lib/server/db";
import { createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// 공개 상품 문의 목록(상품 상세): 비공개 가림·작성자 일부 가림·답변 여부·사진 미노출·판매자 격리·운영 중 아닌 쇼핑몰 404.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 박스", price: 30000, status: "ON_SALE" } });
  return { seller, buyer, product };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const get = async (slug: string, productId: string, qs = "") => {
  const res = await publicGet(new Request(`http://localhost:3000/x${qs}`), { params: Promise.resolve({ slug, productId }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const add = (s: Shop, extra: Record<string, unknown>) =>
  db.buyerInquiry.create({
    data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, kind: "PRODUCT", productId: s.product.id, authorNickname: "홍길동", title: "재입고", body: "언제 들어와요?", ...extra } as never,
  });

describe("공개 상품 문의 목록", () => {
  it("공개 글은 제목·내용·답변을 주고 작성자는 첫 글자만 보이며, 사진은 주지 않는다", async () => {
    const s = await shop();
    await add(s, { status: "ANSWERED", answer: "내일 입고돼요", answeredAt: new Date() });
    const r = await get(s.seller.slug, s.product.id);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.inquiries[0]).toMatchObject({ author: "홍***", title: "재입고", body: "언제 들어와요?", answered: true, answer: "내일 입고돼요", isPrivate: false });
    expect(r.body.inquiries[0].images).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain("홍길동");
  });

  it("비공개 글은 제목·내용·답변을 가리고 답변 여부만 보인다", async () => {
    const s = await shop();
    await add(s, { isPrivate: true, title: "내 주문 문의", body: "전화번호 010-1234-5678", status: "ANSWERED", answer: "비밀 답변", answeredAt: new Date() });
    await add(s, { isPrivate: true, title: "대기 중 비밀", body: "비밀 내용" });
    const r = await get(s.seller.slug, s.product.id);
    expect(r.body.inquiries.map((i: any) => [i.title, i.body, i.answer, i.answered])).toEqual([
      ["비밀글입니다", null, null, false],
      ["비밀글입니다", null, null, true],
    ]);
    const text = JSON.stringify(r.body);
    for (const secret of ["내 주문 문의", "010-1234", "비밀 답변", "비밀 내용", "대기 중 비밀"]) expect(text).not.toContain(secret);
  });

  it("탈퇴 회원 표시는 그대로이고, 1:1 문의·다른 상품·다른 판매자 문의는 섞이지 않는다", async () => {
    const s = await shop();
    const other = await shop();
    const otherProduct = await db.product.create({ data: { sellerId: s.seller.id, name: "다른 상품", price: 1000, status: "ON_SALE" } });
    await add(s, { authorNickname: "탈퇴한 회원" });
    await add(s, { productId: otherProduct.id, title: "다른 상품 문의" });
    await db.buyerInquiry.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, kind: "GENERAL", authorNickname: "닉", title: "1:1", body: "x" } });
    await add(other, { title: "다른 판매자" });
    const r = await get(s.seller.slug, s.product.id);
    expect(r.body.inquiries.map((i: any) => [i.author, i.title])).toEqual([["탈퇴한 회원", "재입고"]]);
    // 다른 판매자의 슬러그로 이 상품을 부르면 404
    expect((await get(other.seller.slug, s.product.id)).status).toBe(404);
  });

  it("최신순 20개씩 cursor로 이어지고 중복되지 않는다", async () => {
    const s = await shop();
    const t0 = Date.now();
    await db.buyerInquiry.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ sellerId: s.seller.id, buyerMemberId: s.buyer.id, kind: "PRODUCT" as const, productId: s.product.id, authorNickname: "닉", title: `문의 ${i}`, body: "내용", createdAt: new Date(t0 - i * 1000) })),
    });
    const a = await get(s.seller.slug, s.product.id);
    expect(a.body.inquiries).toHaveLength(20);
    expect(a.body.total).toBe(25);
    const b = await get(s.seller.slug, s.product.id, `?cursor=${a.body.nextCursor}`);
    expect(b.body.inquiries).toHaveLength(5);
    expect(b.body.nextCursor).toBeNull();
    expect(new Set([...a.body.inquiries, ...b.body.inquiries].map((i: any) => i.id)).size).toBe(25);
  });

  it("보이지 않는 상품(숨김)·없는 상품·잘못된 id·운영 중이 아닌 쇼핑몰은 404이다", async () => {
    const s = await shop();
    await add(s, {});
    const hidden = await db.product.create({ data: { sellerId: s.seller.id, name: "중지", price: 1000, status: "HIDDEN" } });
    expect((await get(s.seller.slug, hidden.id)).status).toBe(404);
    expect((await get(s.seller.slug, "11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await get(s.seller.slug, "nope")).status).toBe(404);
    expect((await get("no-such-shop", s.product.id)).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await get(s.seller.slug, s.product.id)).status).toBe(404);
  });
});
