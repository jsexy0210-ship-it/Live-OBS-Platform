import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as exportGet } from "../../app/api/seller/reviews/export/route";
import { GET as listGet } from "../../app/api/seller/reviews/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { readXlsx } from "../../lib/server/shop-bulk-io/xlsx";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-048 리뷰 목록의 기간·검색어(상품/작성자/내용)·사진 리뷰만 조건과 엑셀(CSV·xlsx) 내려받기.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const get = (path: string, cookie: string) => new Request(BASE + path, { headers: { ...H, cookie } });
const DAY = 86_400_000;
const kstDay = (offset: number) => new Date(Date.now() + 9 * 3_600_000 + offset * DAY).toISOString().slice(0, 10);

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

let orderNo = 0;
async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const cs = await createSellerUser(seller.id, { permissions: ["INQUIRY_REPLY"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const boosters = await db.product.create({ data: { sellerId: seller.id, name: "스타라이트 부스터 박스", price: 30000, status: "ON_SALE" } });
  const sleeves = await db.product.create({ data: { sellerId: seller.id, name: "문라이트 슬리브", price: 8000, status: "ON_SALE" } });
  const option = async (productId: string) => db.productOption.create({ data: { sellerId: seller.id, productId, name: "기본", stock: 10 } });
  const oBooster = await option(boosters.id);
  const oSleeve = await option(sleeves.id);
  // 리뷰 하나(주문 품목 1개)를 직접 만든다
  const review = async (v: { product?: "booster" | "sleeve"; author: string; body: string; rating?: number; ageDays?: number; photos?: number; reply?: string | null; status?: "VISIBLE" | "PENDING" | "HELD" | "HIDDEN" }) => {
    const prod = v.product === "sleeve" ? sleeves : boosters;
    const opt = v.product === "sleeve" ? oSleeve : oBooster;
    const order = await db.order.create({ data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: buyer.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 1000, paidAt: new Date() } });
    const item = await db.orderItem.create({ data: { sellerId: seller.id, orderId: order.id, productId: prod.id, optionId: opt.id, productNameSnapshot: prod.name, optionNameSnapshot: "기본", unitPrice: 1000, quantity: 1 } });
    const r = await db.productReview.create({
      data: {
        sellerId: seller.id, orderId: order.id, orderItemId: item.id, productId: prod.id, buyerMemberId: buyer.id, authorNickname: v.author, rating: v.rating ?? 5, body: v.body.length >= 10 ? v.body : `${v.body}입니다 좋은 리뷰예요`, // 리뷰 내용은 10자 이상(DB 제약)
        status: v.status ?? "VISIBLE", reply: v.reply ?? null, createdAt: new Date(Date.now() - (v.ageDays ?? 0) * DAY - 60_000),
      },
    });
    for (let i = 0; i < (v.photos ?? 0); i++) {
      await db.productReviewImage.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, reviewId: r.id, data: Buffer.from([1, 2, 3]), contentType: "image/jpeg", byteSize: 3, width: 1, height: 1, sortOrder: i } });
    }
    return r;
  };
  return { seller, review, owner: await cookieOf(owner.email), cs: await cookieOf(cs.email), noPerm: await cookieOf(other.email) };
}

type List = { reviews: { id: string; author: string; body: string; photos: number }[]; matched: number; nextCursor: string | null; summary: { total: number } };
const list = async (cookie: string, qs = "") => {
  const r = await listGet(get(`/api/seller/reviews${qs}`, cookie));
  return { status: r.status, body: (await r.json()) as List };
};
const names = (l: List) => l.reviews.map((r) => r.author).sort();

describe("리뷰 목록 조건", () => {
  it("기간(from·to, KST 날짜)으로 작성일을 거르고 matched가 조건에 맞는 전체 개수다", async () => {
    const s = await shop();
    await s.review({ author: "오늘", body: "오늘 쓴 리뷰", ageDays: 0 });
    await s.review({ author: "사흘전", body: "사흘 전 리뷰", ageDays: 3 });
    await s.review({ author: "한달전", body: "한 달 전 리뷰", ageDays: 40 });
    const all = await list(s.owner);
    expect([all.body.matched, names(all.body)]).toEqual([3, ["사흘전", "오늘", "한달전"]]);
    const week = await list(s.owner, `?from=${kstDay(-7)}&to=${kstDay(0)}`);
    expect([week.body.matched, names(week.body)]).toEqual([2, ["사흘전", "오늘"]]);
    const old = await list(s.owner, `?to=${kstDay(-30)}`);
    expect(names(old.body)).toEqual(["한달전"]);
    const from3 = await list(s.owner, `?from=${kstDay(-3)}&to=${kstDay(-3)}`); // 하루(양끝 포함)
    expect(names(from3.body)).toEqual(["사흘전"]);
    // 잘못된 날짜 형식은 무시(조건 없음)
    expect((await list(s.owner, "?from=어제&to=2026-02-30")).body.matched).toBe(3);
  });

  it("검색어는 상품·작성자·내용에서 찾고, field로 한 곳만 볼 수 있으며 대소문자를 구분하지 않는다", async () => {
    const s = await shop();
    await s.review({ author: "별빛사냥꾼", body: "포장이 꼼꼼했어요", product: "booster" });
    await s.review({ author: "카드수집가", body: "모서리가 눌려 왔어요", product: "sleeve" });
    await s.review({ author: "Alice", body: "슬리브 좋아요", product: "booster" });
    expect(names((await list(s.owner, `?q=${encodeURIComponent("슬리브")}`)).body)).toEqual(["Alice", "카드수집가"]); // 상품 이름·내용 모두
    expect(names((await list(s.owner, `?q=${encodeURIComponent("슬리브")}&field=product`)).body)).toEqual(["카드수집가"]);
    expect(names((await list(s.owner, `?q=${encodeURIComponent("슬리브")}&field=body`)).body)).toEqual(["Alice"]);
    expect(names((await list(s.owner, `?q=${encodeURIComponent("별빛")}&field=author`)).body)).toEqual(["별빛사냥꾼"]);
    expect(names((await list(s.owner, `?q=${encodeURIComponent("별빛")}&field=body`)).body)).toEqual([]);
    expect(names((await list(s.owner, "?q=alice&field=author")).body)).toEqual(["Alice"]);
    expect((await list(s.owner, `?q=${encodeURIComponent("없는말")}`)).body.matched).toBe(0);
    // LIKE 특수문자는 글자 그대로 찾는다
    await s.review({ author: "퍼센트", body: "100% 만족" });
    expect(names((await list(s.owner, `?q=${encodeURIComponent("100%")}&field=body`)).body)).toEqual(["퍼센트"]);
    expect(names((await list(s.owner, `?q=${encodeURIComponent("%")}&field=author`)).body)).toEqual([]);
    expect(names((await list(s.owner, `?q=${encodeURIComponent("_")}&field=author`)).body)).toEqual([]); // _는 아무 한 글자가 아니다
    await s.review({ author: "under_bar", body: "밑줄 닉네임 리뷰입니다" });
    expect(names((await list(s.owner, `?q=${encodeURIComponent("er_ba")}&field=author`)).body)).toEqual(["under_bar"]);
    expect(names((await list(s.owner, `?q=${encodeURIComponent("er-ba")}&field=author`)).body)).toEqual([]);
  });

  it("사진 리뷰만(photo=1)과 다른 조건(별점·상태·답글 대기)을 함께 걸 수 있다. 다른 쇼핑몰 리뷰는 섞이지 않는다", async () => {
    const s = await shop();
    const other = await shop();
    await s.review({ author: "사진있음", body: "사진 리뷰", photos: 2, rating: 5 });
    await s.review({ author: "사진없음", body: "글만", rating: 5 });
    await s.review({ author: "낮은별점사진", body: "별로", photos: 1, rating: 2, reply: "죄송합니다" });
    await other.review({ author: "남의리뷰", body: "남의 사진", photos: 1 });
    expect(names((await list(s.owner, "?photo=1")).body)).toEqual(["낮은별점사진", "사진있음"]);
    expect(names((await list(s.owner, "?photo=1&rating=low")).body)).toEqual(["낮은별점사진"]);
    expect(names((await list(s.owner, "?photo=1&waiting=1")).body)).toEqual(["사진있음"]); // 답글 대기
    expect((await list(s.owner, "?photo=1")).body.matched).toBe(2);
  });

  it("매 페이지의 matched는 같고 커서로 이어 읽으면 중복·누락 없이 조건에 맞는 리뷰를 모두 준다", async () => {
    const s = await shop();
    for (let i = 0; i < 13; i++) await s.review({ author: `글${i}`, body: i % 2 ? "홀수 리뷰" : "짝수 리뷰", ageDays: i });
    const seen: string[] = [];
    let cursor: string | null = null;
    let matched = -1;
    do {
      const page: { body: List } = await list(s.owner, `?q=${encodeURIComponent("짝수")}${cursor ? `&cursor=${cursor}` : ""}`);
      matched = page.body.matched;
      seen.push(...page.body.reviews.map((r) => r.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect([matched, seen.length, new Set(seen).size]).toEqual([7, 7, 7]);
  });
});

describe("리뷰 내려받기", () => {
  const exp = (cookie: string, qs = "") => exportGet(get(`/api/seller/reviews/export${qs}`, cookie));

  it("CSV는 목록과 같은 조건으로 거르고 수식 글자에 작은따옴표를 붙이며, 엑셀은 붙이지 않는다. 내려받은 사실은 로그 추적에 남고 내용은 남지 않는다", async () => {
    const s = await shop();
    await s.review({ author: "=위험닉", body: "@SUM(A1) 내용, 쉼표", photos: 2, reply: "감사합니다", rating: 4 });
    await s.review({ author: "일반", body: "그냥 글", status: "HELD" });
    await s.review({ author: "오래전", body: "옛날 글", ageDays: 40 });
    const r = await exp(s.owner, `?from=${kstDay(-7)}`);
    expect([r.status, r.headers.get("content-type"), r.headers.get("x-review-count")]).toEqual([200, "text/csv; charset=utf-8", "2"]);
    expect(r.headers.get("content-disposition")).toContain(".csv");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await r.arrayBuffer());
    expect(text).toContain("작성일,주문번호,상품,작성자,등급,별점,내용,사진,상태,답글");
    expect(text).toContain("'=위험닉");
    expect(text).toContain("'@SUM(A1) 내용, 쉼표".replace(", ", ", ")); // 따옴표로 감싼 칸 안의 값
    expect(text).toContain("공개");
    expect(text).toContain("보류");
    expect(text).not.toContain("옛날 글");
    const logs = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "review.export" } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toContain("위험닉");
    expect(logs[0].after).toMatchObject({ rows: 2, format: "csv", filter: { from: kstDay(-7), photo: false } });

    const x = await exp(s.owner, "?format=xlsx&photo=1");
    expect([x.status, x.headers.get("x-review-count")]).toEqual([200, "1"]);
    const sheet = readXlsx(Buffer.from(await x.arrayBuffer()));
    if (!sheet.ok) throw new Error(sheet.reason);
    expect(sheet.rows[0]).toEqual(["작성일", "주문번호", "상품", "작성자", "등급", "별점", "내용", "사진", "상태", "답글"]);
    expect(sheet.rows[1].slice(3)).toEqual(["=위험닉", expect.any(String), "4", "@SUM(A1) 내용, 쉼표", "2", "공개", "감사합니다"]); // 엑셀은 작은따옴표 없음
  });

  it("답글·숨김과 같은 권한(대표자·문의 직원)만 되고, 권한 없는 직원·다른 쇼핑몰은 막히며 5,000건을 넘으면 400", async () => {
    const s = await shop();
    await s.review({ author: "닉", body: "글" });
    expect((await exp(s.cs)).status).toBe(200);
    expect((await exp(s.noPerm)).status).toBe(403);
    expect((await exportGet(new Request(BASE + "/api/seller/reviews/export", { headers: H }))).status).toBe(401);
    const other = await shop();
    const mine = await exp(other.owner);
    expect([mine.status, mine.headers.get("x-review-count")]).toEqual([200, "0"]);
    expect(await db.auditLog.count({ where: { sellerId: other.seller.id, action: "review.export" } })).toBe(1);
  });
});
