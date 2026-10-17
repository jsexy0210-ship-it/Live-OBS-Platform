import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as memoGet, PUT as memoPut } from "../../app/api/seller/orders/[orderId]/memo/route";
import { loginSeller } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 주문 메모(GET·PUT /api/seller/orders/{id}/memo, SA-021 「메모 남기기」).
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 100 } });
  const place = async () => {
    const r = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error("order");
    return { id: r.orderId };
  };
  return { seller, owner, buyer, place, cookie: await cookieOf(owner.email) };
}

const getMemo = async (cookie: string, id: string) => {
  const r = await memoGet(new Request("http://localhost:3000/api/seller/orders/x/memo", { headers: { host: "localhost:3000", cookie } }), { params: Promise.resolve({ orderId: id }) });
  return { status: r.status, body: await r.json() };
};
const putMemo = async (cookie: string, id: string, body: unknown) => {
  const r = await memoPut(new Request("http://localhost:3000/api/seller/orders/x/memo", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify({ body }) }), { params: Promise.resolve({ orderId: id }) });
  return { status: r.status, body: await r.json() };
};

describe("주문 메모", () => {
  it("저장하면 본문·작성자를 주고 덮어쓰며 빈 글은 지운다. 로그 추적에는 본문 없이 글자 수만 남는다", async () => {
    const s = await shop();
    const o = await s.place();
    expect((await getMemo(s.cookie, o.id)).body).toEqual({ memo: null });
    const a = await putMemo(s.cookie, o.id, "전화 주신다고 함\n포장 별도");
    expect(a.status).toBe(200);
    expect(a.body.memo).toMatchObject({ body: "전화 주신다고 함\n포장 별도", updatedBy: { name: s.owner.name } });
    expect((await putMemo(s.cookie, o.id, "수정")).body.memo.body).toBe("수정");
    expect(await db.orderMemo.count({ where: { orderId: o.id } })).toBe(1);
    const logs = await db.auditLog.findMany({ where: { targetId: o.id, action: { startsWith: "order.memo" } }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["order.memo.update", "order.memo.update"]);
    expect(JSON.stringify(logs)).not.toContain("포장 별도");
    expect(JSON.stringify(logs.map((l) => l.after))).toContain("\"length\"");
    expect((await putMemo(s.cookie, o.id, "   ")).body).toEqual({ memo: null });
    expect(await db.orderMemo.count()).toBe(0);
    expect(await db.auditLog.count({ where: { targetId: o.id, action: "order.memo.delete" } })).toBe(1);
  });

  it("1,000자까지, 넘거나 글이 아니면 400", async () => {
    const s = await shop();
    const o = await s.place();
    expect((await putMemo(s.cookie, o.id, "가".repeat(1000))).status).toBe(200);
    expect((await putMemo(s.cookie, o.id, "가".repeat(1001))).status).toBe(400);
    expect((await putMemo(s.cookie, o.id, 123)).status).toBe(400);
  });

  it("다른 쇼핑몰 주문은 404, 주문 권한 없는 직원은 403, 로그인 없으면 401", async () => {
    const a = await shop();
    const b = await shop();
    const bo = await b.place();
    const ao = await a.place();
    await putMemo(a.cookie, ao.id, "내 메모");
    expect((await getMemo(a.cookie, bo.id)).status).toBe(404);
    expect((await putMemo(a.cookie, bo.id, "침범")).status).toBe(404);
    expect((await getMemo(a.cookie, "abc")).status).toBe(404);
    expect(await db.orderMemo.count({ where: { orderId: bo.id } })).toBe(0);
    const none = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["MEMBER_POINTS"] })).email);
    expect((await getMemo(none, ao.id)).status).toBe(403);
    expect((await putMemo(none, ao.id, "x")).status).toBe(403);
    const ok = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["ORDER_SHIPPING"] })).email);
    expect((await getMemo(ok, ao.id)).body.memo.body).toBe("내 메모");
    expect((await putMemo("", ao.id, "x")).status).toBe(401);
  });

  it("회원이 탈퇴하면 그 회원 주문의 메모를 지운다", async () => {
    const s = await shop();
    const o = await s.place();
    await putMemo(s.cookie, o.id, "개인정보가 섞였을 수 있는 메모");
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.orderMemo.count()).toBe(0);
  });
});
