import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/seller/orders/[orderId]/route";
import { GET as listRoute } from "../../app/api/seller/orders/route";
import { loginSeller } from "../../lib/server/auth/login";
import { getBuyerOrder, listBuyerOrders } from "../../lib/server/orders/buyer";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 사람이 읽는 주문번호(orderNoLabel, 「20261002-0409」): 판매자 주문 목록·상세, 구매자 주문 목록·상세 응답과 판매자 주문 검색.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };
async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await db.buyerMember.update({ where: { id: (await createBuyer(seller.id, grade.id)).id }, data: { broadcastNickname: "기본닉" } });
  const order = (orderNo: number, createdAt: Date, status: "PAID" | "PENDING_PAYMENT" = "PAID") =>
    db.order.create({ data: { sellerId: seller.id, orderNo, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "기본닉", totalAmount: 1000, status, createdAt } });
  return { seller, buyer, order, cookie: await cookieOf(owner.email) };
}
const list = async (cookie: string, qs = "") => {
  const r = await listRoute(new Request(`http://localhost:3000/api/seller/orders${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const ids = (r: { body: { orders: { id: string }[] } }) => r.body.orders.map((o) => o.id).sort();

describe("판매자 주문 목록·상세의 orderNoLabel", () => {
  it("행과 상세에 생성일(KST)+4자리 주문번호가 들어간다(KST 날짜 경계·9999 초과 포함)", async () => {
    const s = await shop();
    const a = await s.order(409, new Date("2026-10-02T03:00:00Z"));
    const edge = await s.order(4, new Date("2026-10-04T15:00:00Z")); // KST 10월 5일 0시
    const big = await s.order(12345, new Date("2026-10-04T14:59:00Z")); // KST 10월 4일
    const rows = Object.fromEntries((await list(s.cookie)).body.orders.map((o: { id: string }) => [o.id, o]));
    expect(rows[a.id]).toMatchObject({ orderNo: 409, orderNoLabel: "20261002-0409" });
    expect(rows[edge.id]).toMatchObject({ orderNo: 4, orderNoLabel: "20261005-0004" });
    expect(rows[big.id]).toMatchObject({ orderNo: 12345, orderNoLabel: "20261004-12345" });
    const d = await detailRoute(new Request("http://localhost:3000/x", { headers: { ...H, cookie: s.cookie } }), { params: Promise.resolve({ orderId: a.id }) });
    expect(d.status).toBe(200);
    expect(await d.json()).toMatchObject({ id: a.id, orderNo: 409, orderNoLabel: "20261002-0409" });
  });

  it("검색 q는 「20261005-0004」·「0004」·「4」 모두로 찾고, 날짜가 다르면 라벨로는 못 찾으며, 기존 동작(번호 전체 일치·닉네임)은 그대로다", async () => {
    const s = await shop();
    const other = await shop();
    const four = await s.order(4, new Date("2026-10-05T01:00:00+09:00"));
    const fourOtherDay = await s.order(4 + 1000, new Date("2026-10-06T01:00:00+09:00")); // 번호 1004
    await s.order(14, new Date("2026-10-05T02:00:00+09:00")); // 「4」에 부분 일치하면 안 된다
    const sameNoOtherSeller = await other.order(4, new Date("2026-10-05T01:00:00+09:00"));
    expect(ids(await list(s.cookie, `?q=${encodeURIComponent("20261005-0004")}`))).toEqual([four.id]);
    expect(ids(await list(s.cookie, "?q=0004"))).toEqual([four.id]);
    expect(ids(await list(s.cookie, "?q=4"))).toEqual([four.id]);
    expect(ids(await list(s.cookie, `?q=${encodeURIComponent("20261005-4")}`))).toEqual([four.id]);
    // 날짜가 다르면(번호만 같아도) 라벨로는 안 나온다
    expect(ids(await list(s.cookie, `?q=${encodeURIComponent("20261006-0004")}`))).toEqual([]);
    expect(ids(await list(s.cookie, `?q=${encodeURIComponent("20261006-1004")}`))).toEqual([fourOtherDay.id]);
    expect(ids(await list(s.cookie, `?q=${encodeURIComponent("20261305-0004")}`))).toEqual([]);
    // 다른 판매자의 같은 번호·날짜 주문은 섞이지 않는다
    expect(ids(await list(other.cookie, `?q=${encodeURIComponent("20261005-0004")}`))).toEqual([sameNoOtherSeller.id]);
    // 기존: 닉네임 부분 일치, 숫자 아닌 검색어
    expect(ids(await list(s.cookie, `?q=${encodeURIComponent("기본닉")}`))).toHaveLength(3);
    expect((await list(s.cookie, `?q=${"9".repeat(51)}`)).status).toBe(400);
  });
});

describe("구매자 주문 목록·상세의 orderNoLabel", () => {
  it("본인 주문 목록·상세에 orderNoLabel이 들어간다", async () => {
    const s = await shop();
    const a = await s.order(409, new Date("2026-10-02T03:00:00Z"));
    await s.order(10, new Date("2026-10-03T03:00:00Z"));
    const scope = { sellerId: s.seller.id, buyerMemberId: s.buyer.id };
    const l = await listBuyerOrders(db, scope);
    if (!l.ok) throw new Error("list");
    expect(l.value.orders.map((o) => [o.orderNo, o.orderNoLabel])).toEqual([[10, "20261003-0010"], [409, "20261002-0409"]]);
    expect(await getBuyerOrder(db, scope, a.id)).toMatchObject({ orderNo: 409, orderNoLabel: "20261002-0409" });
  });
});
