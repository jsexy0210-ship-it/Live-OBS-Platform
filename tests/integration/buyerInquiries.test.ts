import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerImageGet } from "../../app/api/seller/inquiries/images/[imageId]/route";
import { PUT as answerPut } from "../../app/api/seller/inquiries/[inquiryId]/answer/route";
import { GET as sellerDetail } from "../../app/api/seller/inquiries/[inquiryId]/route";
import { GET as sellerList } from "../../app/api/seller/inquiries/route";
import { POST as imagePost } from "../../app/api/shop/[slug]/inquiries/images/route";
import { GET as myImageGet } from "../../app/api/shop/[slug]/inquiries/images/[imageId]/route";
import { DELETE as inquiryDelete, GET as inquiryGet, PUT as inquiryPut } from "../../app/api/shop/[slug]/inquiries/[inquiryId]/route";
import { GET as myList, POST as inquiryPost } from "../../app/api/shop/[slug]/inquiries/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { INQUIRY_RATE_LIMIT } from "../../lib/server/buyer-inquiries/service";
import { jpeg } from "../unit/productImageFormatsFixtures";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 구매자 문의(상품 문의·1:1): 쓰기·내 목록·답변 전 고치기/지우기, 파트너스 목록(상태·기간·검색)·상세·답변, 판매자 격리, 권한, 탈퇴.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (method: string, cookie: string | null, body?: unknown) =>
  new Request(BASE + "/x", { method, headers: { ...H, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const replyStaff = await createSellerUser(seller.id, { permissions: ["INQUIRY_REPLY"] });
  const otherStaff = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const buyer2 = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 박스", price: 30000, status: "ON_SALE" } });
  const sc = async (email: string) => {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  const bc = async (m: { loginId: string | null }) => {
    const r = await loginBuyer(db, { sellerId: seller.id, loginId: m.loginId!, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_buyer=${r.token}`;
  };
  return { seller, slug: seller.slug, grade, buyer, buyer2, product, owner: await sc(owner.email), reply: await sc(replyStaff.email), noPerm: await sc(otherStaff.email), b1: await bc(buyer), b2: await bc(buyer2) };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const write = async (s: Shop, body: Record<string, unknown>, cookie = s.b1, slug = s.slug) => {
  const res = await inquiryPost(req("POST", cookie, body), p({ slug }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
// 같은 밀리초에 만들어진 행은 최신순·시간순 정렬에서 순서가 id(무작위)로 갈린다. 순서를 비교하는 시험은 쓰기 사이에 시각을 벌린다
const tick = () => new Promise((r) => setTimeout(r, 5));
const general = (extra: Record<string, unknown> = {}) => ({ kind: "GENERAL", title: "배송 문의", body: "언제 도착하나요?", ...extra });
const productQ = (s: Shop, extra: Record<string, unknown> = {}) => ({ kind: "PRODUCT", productId: s.product.id, title: "재입고", body: "재입고 일정이 궁금해요", ...extra });
const mine = async (s: Shop, cookie = s.b1) => ((await (await myList(req("GET", cookie), p({ slug: s.slug }))).json()) as { inquiries: any[] }).inquiries;
const uploadImage = async (s: Shop, cookie = s.b1) => {
  const res = await imagePost(new Request(BASE + "/x", { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(jpeg(800, 600, { exif: true })) }), p({ slug: s.slug }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const answer = async (s: Shop, id: string, a: unknown, cookie = s.owner) => {
  const res = await answerPut(req("PUT", cookie, { answer: a }), p({ inquiryId: id }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const list = async (s: Shop, qs = "", cookie = s.owner) => {
  const res = await sellerList(new Request(`${BASE}/api/seller/inquiries${qs}`, { headers: { ...H, cookie } }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("구매자 쓰기·내 문의", () => {
  it("상품 문의와 1:1 문의를 쓰고, 내 목록에는 내 것만 최신순으로 나온다", async () => {
    const s = await shop();
    expect((await write(s, productQ(s, { isPrivate: true }))).status).toBe(201);
    await tick();
    expect((await write(s, general())).status).toBe(201);
    expect((await write(s, general({ title: "다른 구매자" }), s.b2)).status).toBe(201);
    const l = await mine(s);
    expect(l.map((x) => x.title)).toEqual(["배송 문의", "재입고"]);
    expect(l[1]).toMatchObject({ kind: "PRODUCT", isPrivate: true, status: "WAITING", product: { id: s.product.id, name: "부스터 박스" } });
    expect(l[0].product).toBeNull();
  });

  it("본인 주문 대상 1:1 문의를 저장·답변하고 다른 구매자·판매자 주문은 거절한다", async () => {
    const s = await shop();
    const other = await shop();
    const order = await db.order.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderNo: 1, broadcastNicknameSnapshot: s.buyer.broadcastNickname, totalAmount: 0 } });
    const anotherBuyerOrder = await db.order.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer2.id, orderNo: 2, broadcastNicknameSnapshot: s.buyer2.broadcastNickname, totalAmount: 0 } });
    const heldOrder = await db.order.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderNo: 3, broadcastNicknameSnapshot: s.buyer.broadcastNickname, totalAmount: 0, legalHoldAt: new Date() } });
    const otherSellerOrder = await db.order.create({ data: { sellerId: other.seller.id, buyerMemberId: other.buyer.id, orderNo: 1, broadcastNicknameSnapshot: other.buyer.broadcastNickname, totalAmount: 0 } });
    const before = await db.buyerInquiry.count();
    for (const orderId of [anotherBuyerOrder.id, otherSellerOrder.id, heldOrder.id, "11111111-1111-4111-8111-111111111111"]) {
      const denied = await write(s, general({ orderId }));
      expect(denied.status).toBe(400);
      expect(denied.body.error).toBe("invalid_order");
    }
    expect((await write(s, productQ(s, { orderId: order.id }))).body.error).toBe("invalid_order");
    expect(await db.buyerInquiry.count()).toBe(before);
    const made = await write(s, general({ orderId: order.id }));
    expect(made.status).toBe(201);
    const own = (await mine(s))[0];
    expect(own).toMatchObject({ id: made.body.id, kind: "GENERAL", product: null, order: { id: order.id } });
    expect(own.order.orderNoLabel).toMatch(/^\d{8}-0001$/);
    const sellerRow = (await list(s)).body.inquiries[0];
    expect(sellerRow.order).toEqual(own.order);
    expect((await list(other)).body.inquiries).toHaveLength(0);
    expect((await answer(s, made.body.id as string, "확인했습니다")).status).toBe(200);
    expect((await mine(s))[0]).toMatchObject({ order: own.order, answer: "확인했습니다" });
    expect((await write(s, general())).status).toBe(201);
    expect((await mine(s))[0].order).toBeNull();
  });

  it("종류·상품·제목·내용·사진 입력을 검사한다", async () => {
    const s = await shop();
    expect((await write(s, { ...general(), kind: "X" })).body.error).toBe("invalid_kind");
    expect((await write(s, { ...productQ(s), productId: undefined })).body.error).toBe("invalid_product");
    expect((await write(s, { ...general(), productId: s.product.id })).body.error).toBe("invalid_product");
    expect((await write(s, productQ(s, { productId: "11111111-1111-4111-8111-111111111111" }))).body.error).toBe("invalid_product");
    expect((await write(s, general({ title: "" }))).body.error).toBe("invalid_title");
    expect((await write(s, general({ title: "가".repeat(51) }))).body.error).toBe("invalid_title");
    expect((await write(s, general({ body: "  " }))).body.error).toBe("invalid_body");
    expect((await write(s, general({ imageIds: ["11111111-1111-4111-8111-111111111111"] }))).body.error).toBe("invalid_images");
    expect(await db.buyerInquiry.count()).toBe(0);
  });

  it("다른 판매자의 상품은 문의 대상이 아니고, 로그인이 없으면 401이다", async () => {
    const a = await shop();
    const b = await shop();
    expect((await write(a, productQ(b))).body.error).toBe("invalid_product");
    expect((await write(a, general(), "")).status).toBe(401);
  });

  it("1시간에 10건까지만 쓸 수 있다(동시에 써도 넘지 않는다)", async () => {
    const s = await shop();
    const rs = await Promise.all(Array.from({ length: INQUIRY_RATE_LIMIT + 4 }, () => write(s, general())));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(INQUIRY_RATE_LIMIT);
    expect(rs.filter((r) => r.status === 429).every((r) => r.body.error === "inquiry_rate_limited")).toBe(true);
  });

  it("사진을 붙이고(위치 정보 제거) 남의 사진은 붙이지도 보지도 못한다", async () => {
    const s = await shop();
    const img = await uploadImage(s);
    expect(img.status).toBe(201);
    const stored = await db.buyerInquiryImage.findUniqueOrThrow({ where: { id: img.body.image.id } });
    expect(Buffer.from(stored.data).includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    // 다른 구매자는 이 사진을 붙이지 못한다
    expect((await write(s, general({ imageIds: [img.body.image.id] }), s.b2)).body.error).toBe("invalid_images");
    expect((await myImageGet(req("GET", s.b2), p({ slug: s.slug, imageId: img.body.image.id }))).status).toBe(404);
    expect((await myImageGet(req("GET", s.b1), p({ slug: s.slug, imageId: img.body.image.id }))).status).toBe(200);
    const w = await write(s, general({ imageIds: [img.body.image.id] }));
    expect(w.status).toBe(201);
    expect((await mine(s))[0].images).toHaveLength(1);
    // 한 사진은 한 문의에만 붙는다
    expect((await write(s, general({ imageIds: [img.body.image.id] }))).body.error).toBe("invalid_images");
    expect((await imagePost(new Request(BASE + "/x", { method: "POST", headers: { ...H, cookie: s.b1 }, body: new Uint8Array(Buffer.from("not an image")) }), p({ slug: s.slug }))).status).toBe(400);
  });
});

describe("답변 전 고치기·지우기", () => {
  it("답변 전에는 고치고 지울 수 있고, 남의 문의는 404이다", async () => {
    const s = await shop();
    const id = (await write(s, productQ(s))).body.id as string;
    const edit = await inquiryPut(req("PUT", s.b1, { title: "수정 제목", body: "수정 내용", isPrivate: true }), p({ slug: s.slug, inquiryId: id }));
    expect(edit.status).toBe(200);
    const row = await db.buyerInquiry.findUniqueOrThrow({ where: { sellerId_id: { sellerId: s.seller.id, id } } });
    expect([row.title, row.body, row.isPrivate, row.kind]).toEqual(["수정 제목", "수정 내용", true, "PRODUCT"]);
    expect((await inquiryPut(req("PUT", s.b2, { title: "가로채기", body: "x" }), p({ slug: s.slug, inquiryId: id }))).status).toBe(404);
    expect((await inquiryDelete(req("DELETE", s.b2), p({ slug: s.slug, inquiryId: id }))).status).toBe(404);
    expect((await inquiryGet(req("GET", s.b2), p({ slug: s.slug, inquiryId: id }))).status).toBe(404);
    expect((await inquiryDelete(req("DELETE", s.b1), p({ slug: s.slug, inquiryId: id }))).status).toBe(200);
    expect(await db.buyerInquiry.count()).toBe(0);
  });

  it("지우면 붙은 사진도 함께 지워진다", async () => {
    const s = await shop();
    const img = await uploadImage(s);
    const id = (await write(s, general({ imageIds: [img.body.image.id] }))).body.id as string;
    await inquiryDelete(req("DELETE", s.b1), p({ slug: s.slug, inquiryId: id }));
    expect(await db.buyerInquiryImage.count()).toBe(0);
  });

  it("답변이 달리면 고치거나 지울 수 없다(409), 답변을 지우면 다시 가능하다", async () => {
    const s = await shop();
    const id = (await write(s, general())).body.id as string;
    expect((await answer(s, id, "내일 도착합니다")).status).toBe(200);
    const edit = await inquiryPut(req("PUT", s.b1, { title: "수정", body: "수정" }), p({ slug: s.slug, inquiryId: id }));
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { error: string }).error).toBe("already_answered");
    expect((await inquiryDelete(req("DELETE", s.b1), p({ slug: s.slug, inquiryId: id }))).status).toBe(409);
    expect((await mine(s))[0]).toMatchObject({ status: "ANSWERED", answer: "내일 도착합니다" });
    expect((await answer(s, id, null)).status).toBe(200);
    expect((await inquiryDelete(req("DELETE", s.b1), p({ slug: s.slug, inquiryId: id }))).status).toBe(200);
  });

  it("답변과 고치기가 동시에 와도 한쪽만 이긴다(답변 달린 글이 고쳐지지 않는다)", async () => {
    const s = await shop();
    const id = (await write(s, general())).body.id as string;
    const [a, e] = await Promise.all([answer(s, id, "답변"), inquiryPut(req("PUT", s.b1, { title: "새 제목", body: "새 내용" }), p({ slug: s.slug, inquiryId: id }))]);
    expect(a.status).toBe(200);
    const row = await db.buyerInquiry.findUniqueOrThrow({ where: { sellerId_id: { sellerId: s.seller.id, id } } });
    expect(row.status).toBe("ANSWERED");
    // 고치기가 먼저 끝났다면 새 제목이, 답변이 먼저면 409이고 원래 제목이 남는다
    expect(e.status === 200 ? row.title === "새 제목" : row.title === "배송 문의").toBe(true);
  });
});

describe("파트너스 목록·상세·답변", () => {
  it("상태·종류·기간·검색으로 거르고, 다른 판매자 문의는 보이지 않는다", async () => {
    const s = await shop();
    const other = await shop();
    await write(other, general({ title: "남의 문의" }), other.b1, other.slug);
    const a = (await write(s, productQ(s))).body.id as string;
    await write(s, general({ title: "교환 문의", body: "사이즈 교환" }));
    await answer(s, a, "곧 입고됩니다");
    const all = await list(s);
    expect(all.body.inquiries.map((x: any) => x.title).sort()).toEqual(["교환 문의", "재입고"]);
    expect(all.body.waitingCount).toBe(1);
    expect(all.body.canEdit).toBe(true);
    expect((await list(s, "?status=WAITING")).body.inquiries.map((x: any) => x.title)).toEqual(["교환 문의"]);
    expect((await list(s, "?kind=PRODUCT")).body.inquiries.map((x: any) => x.title)).toEqual(["재입고"]);
    expect((await list(s, `?q=${encodeURIComponent("부스터")}`)).body.inquiries.map((x: any) => x.title)).toEqual(["재입고"]); // 상품명 검색
    expect((await list(s, `?q=${encodeURIComponent("교환")}`)).body.inquiries).toHaveLength(1);
    expect((await list(s, "?from=2000-01-01&to=2000-01-02")).body.inquiries).toHaveLength(0);
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    expect((await list(s, `?from=${today}&to=${today}`)).body.inquiries).toHaveLength(2);
    expect((await list(s, "?from=2026-02-30")).body.error).toBe("invalid_range");
    expect((await list(s, "?from=2026-10-05&to=2026-10-01")).body.error).toBe("invalid_range");
    expect((await list(s, "?status=NOPE")).body.error).toBe("invalid_status");
  });

  it("다음 쪽(cursor)이 이어지고 중복되지 않는다", async () => {
    const s = await shop();
    const t0 = Date.now();
    await db.buyerInquiry.createMany({
      data: Array.from({ length: 35 }, (_, i) => ({ sellerId: s.seller.id, buyerMemberId: s.buyer.id, kind: "GENERAL" as const, authorNickname: "닉", title: `문의 ${i}`, body: "내용", createdAt: new Date(t0 - i * 1000), updatedAt: new Date(t0 - i * 1000) })),
    });
    const first = await list(s);
    expect(first.body.inquiries).toHaveLength(30);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await list(s, `?cursor=${first.body.nextCursor}`);
    expect(second.body.inquiries).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.inquiries, ...second.body.inquiries].map((x: any) => x.id)).size).toBe(35);
  });

  it("상세에 사진·작성자 닉네임이 있고, 다른 판매자 문의·사진은 404이다", async () => {
    const s = await shop();
    const other = await shop();
    const img = await uploadImage(s);
    const id = (await write(s, general({ imageIds: [img.body.image.id], isPrivate: true }))).body.id as string;
    const d = await sellerDetail(new Request(BASE + "/x", { headers: { ...H, cookie: s.owner } }), p({ inquiryId: id }));
    const body = (await d.json()) as { inquiry: any; canEdit: boolean };
    expect(body.inquiry).toMatchObject({ id, isPrivate: true, authorNickname: s.buyer.broadcastNickname });
    expect(body.inquiry.images[0].url).toBe(`/api/seller/inquiries/images/${img.body.image.id}`);
    expect((await sellerImageGet(new Request(BASE + "/x", { headers: { ...H, cookie: s.owner } }), p({ imageId: img.body.image.id }))).status).toBe(200);
    expect((await sellerDetail(new Request(BASE + "/x", { headers: { ...H, cookie: other.owner } }), p({ inquiryId: id }))).status).toBe(404);
    expect((await sellerImageGet(new Request(BASE + "/x", { headers: { ...H, cookie: other.owner } }), p({ imageId: img.body.image.id }))).status).toBe(404);
    expect((await answer(other, id, "남의 문의에 답변", other.owner)).status).toBe(404);
  });

  it("대표자·문의 답변 권한 직원만 답변하고, 다른 직원은 조회만 한다", async () => {
    const s = await shop();
    const id = (await write(s, general())).body.id as string;
    await tick();
    expect((await answer(s, id, "권한 없음", s.noPerm)).status).toBe(403);
    expect((await list(s, "", s.noPerm)).body.canEdit).toBe(false);
    expect((await answer(s, id, "직원 답변", s.reply)).status).toBe(200);
    await tick();
    expect((await answer(s, id, "수정 답변")).status).toBe(200);
    expect((await answer(s, id, "")).body.error).toBe("invalid_answer");
    expect((await answer(s, id, "가".repeat(1001))).body.error).toBe("invalid_answer");
    expect((await answer(s, id, undefined)).body.error).toBe("invalid_answer");
    const row = await db.buyerInquiry.findFirstOrThrow({ where: { id } });
    expect([row.status, row.answer]).toEqual(["ANSWERED", "수정 답변"]);
    const logs = await db.auditLog.findMany({ where: { targetId: id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["buyer_inquiry.create", "buyer_inquiry.answer", "buyer_inquiry.answer_update"]);
    // 로그 추적에 글 내용은 남기지 않는다
    expect(JSON.stringify(logs)).not.toContain("언제 도착하나요");
    expect(JSON.stringify(logs)).not.toContain("수정 답변");
  });
});

describe("탈퇴", () => {
  it("작성자 표시를 비식별하고 사진을 지우며 글은 남긴다", async () => {
    const s = await shop();
    const img = await uploadImage(s);
    const id = (await write(s, general({ imageIds: [img.body.image.id] }))).body.id as string;
    await uploadImage(s); // 붙지 않은 사진
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    const row = await db.buyerInquiry.findFirstOrThrow({ where: { id } });
    expect(row.authorNickname).toBe("탈퇴한 회원");
    expect(row.body).toBe("언제 도착하나요?");
    expect(await db.buyerInquiryImage.count()).toBe(0);
    const detail = await sellerDetail(new Request(BASE + "/x", { headers: { ...H, cookie: s.owner } }), p({ inquiryId: id }));
    expect(((await detail.json()) as { inquiry: { authorNickname: string; images: unknown[] } }).inquiry).toMatchObject({ authorNickname: "탈퇴한 회원", images: [] });
  });
});
