import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as manualRoute } from "../../app/api/seller/purchase-restrictions/[buyerMemberId]/route";
import { POST as liftRoute } from "../../app/api/seller/purchase-restrictions/[buyerMemberId]/lift/route";
import { GET as restrictionsRoute } from "../../app/api/seller/purchase-restrictions/route";
import { GET as memoGet, PUT as memoPut } from "../../app/api/seller/members/[memberId]/memo/route";
import { loginSeller } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 회원 메모(GET·PUT /api/seller/members/{id}/memo)와 구매 제한 직접 걸기(POST /api/seller/purchase-restrictions/{id}, SA-042).
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
  const place = () => createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
  return { seller, grade, owner, buyer, place, cookie: await cookieOf(owner.email) };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const getMemo = async (cookie: string, id: string) => {
  const r = await memoGet(new Request("http://localhost:3000/api/seller/members/x/memo", { headers: { host: "localhost:3000", cookie } }), { params: Promise.resolve({ memberId: id }) });
  return { status: r.status, body: await r.json() };
};
const putMemo = async (cookie: string, id: string, body: unknown) => {
  const r = await memoPut(new Request("http://localhost:3000/api/seller/members/x/memo", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify({ body }) }), { params: Promise.resolve({ memberId: id }) });
  return { status: r.status, body: await r.json() };
};
const restrict = async (cookie: string, id: string, payload: object = {}) => {
  const r = await manualRoute(new Request("http://localhost:3000/api/seller/purchase-restrictions/x", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(payload) }), { params: Promise.resolve({ buyerMemberId: id }) });
  return { status: r.status, body: await r.json() };
};

describe("회원 메모", () => {
  it("저장하면 본문·작성자·수정 시각을 주고, 다시 저장하면 덮어쓰며, 빈 글은 지운다. 로그 추적에는 본문 없이 글자 수만 남는다", async () => {
    const s = await shop();
    expect((await getMemo(s.cookie, s.buyer.id)).body).toEqual({ memo: null });
    const a = await putMemo(s.cookie, s.buyer.id, "단골\n교환 잦음");
    expect(a.status).toBe(200);
    expect(a.body.memo).toMatchObject({ body: "단골\n교환 잦음", updatedBy: { name: s.owner.name } });
    const first = a.body.memo.updatedAt;
    const b = await putMemo(s.cookie, s.buyer.id, "수정한 메모");
    expect(b.body.memo.body).toBe("수정한 메모");
    expect(new Date(b.body.memo.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime());
    expect(await db.memberMemo.count({ where: { buyerMemberId: s.buyer.id } })).toBe(1);
    const logs = await db.auditLog.findMany({ where: { action: { startsWith: "member.memo." }, targetId: s.buyer.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["member.memo.update", "member.memo.update"]);
    expect(JSON.stringify(logs)).not.toContain("수정한 메모");
    expect(logs[1].after).toEqual({ length: 6 });
    expect((await putMemo(s.cookie, s.buyer.id, "  ")).body).toEqual({ memo: null });
    expect(await db.memberMemo.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: "member.memo.delete" } })).toBe(1);
  });

  it("1,000자를 넘거나 글자가 잘못되면 400, 판매자 격리·권한·로그인", async () => {
    const a = await shop();
    const b = await shop();
    expect((await putMemo(a.cookie, a.buyer.id, "가".repeat(1001))).status).toBe(400);
    expect((await putMemo(a.cookie, a.buyer.id, "가".repeat(1000))).status).toBe(200);
    expect((await putMemo(a.cookie, a.buyer.id, 123)).status).toBe(400);
    // 다른 판매자 회원·없는 회원·잘못된 id는 404, 남의 메모는 만들어지지 않는다
    expect((await getMemo(a.cookie, b.buyer.id)).status).toBe(404);
    expect((await putMemo(a.cookie, b.buyer.id, "침범")).status).toBe(404);
    expect((await getMemo(a.cookie, "abc")).status).toBe(404);
    expect(await db.memberMemo.count({ where: { buyerMemberId: b.buyer.id } })).toBe(0);
    // 회원 권한 없는 직원 403, 보기만 있는 직원은 쓰기 403(읽기 허용 여부는 MEMBER_POINTS)
    const none = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["ORDER_SHIPPING"] })).email);
    expect((await getMemo(none, a.buyer.id)).status).toBe(403);
    expect((await putMemo(none, a.buyer.id, "x")).status).toBe(403);
    const member = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["MEMBER_POINTS"] })).email);
    expect((await getMemo(member, a.buyer.id)).body.memo.body).toHaveLength(1000);
    expect((await putMemo("", a.buyer.id, "x")).status).toBe(401);
  });

  it("탈퇴하면 메모를 지우고 상세는 404가 된다", async () => {
    const s = await shop();
    await putMemo(s.cookie, s.buyer.id, "개인정보가 섞였을 수 있는 메모");
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.memberMemo.count()).toBe(0);
    expect((await getMemo(s.cookie, s.buyer.id)).status).toBe(404);
  });
});

describe("구매 제한 직접 걸기", () => {
  const list = async (s: Shop) => (await (await restrictionsRoute(new Request("http://localhost:3000/api/seller/purchase-restrictions", { headers: { host: "localhost:3000", cookie: s.cookie } }))).json()).restrictions;

  it("걸면 주문이 막히고 목록에 사유(MANUAL)·메모·기간이 나오며, 로그 추적에 남고, 풀면 다시 주문할 수 있다", async () => {
    const s = await shop();
    expect((await s.place()).ok).toBe(true);
    const r = await restrict(s.cookie, s.buyer.id, { days: 7, note: "허위 주문 의심" });
    expect(r.status).toBe(201);
    expect(r.body.restriction).toMatchObject({ buyerMemberId: s.buyer.id, reason: "MANUAL", note: "허위 주문 의심" });
    const days = (new Date(r.body.restriction.endsAt).getTime() - new Date(r.body.restriction.startsAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 5);
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
    expect(await list(s)).toEqual([expect.objectContaining({ buyerMemberId: s.buyer.id, reason: "MANUAL", note: "허위 주문 의심" })]);
    const log = await db.auditLog.findFirst({ where: { action: "buyer.purchase_restriction.create", actorType: "SELLER_USER", targetId: s.buyer.id } });
    expect(log).toMatchObject({ actorId: s.owner.id, sellerId: s.seller.id, reason: null, after: { reason: "MANUAL", days: 7, noteLength: 8 } });
    expect(JSON.stringify(log)).not.toContain("허위 주문 의심");
    const lift = await liftRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ reason: "오해 풀림" }) }), { params: Promise.resolve({ buyerMemberId: s.buyer.id }) });
    expect(lift.status).toBe(200);
    expect((await s.place()).ok).toBe(true);
  });

  it("기본 30일, 이미 걸려 있으면 409, 값이 잘못되면 400", async () => {
    const s = await shop();
    const r = await restrict(s.cookie, s.buyer.id);
    expect(r.status).toBe(201);
    expect(r.body.restriction.note).toBeNull();
    expect((new Date(r.body.restriction.endsAt).getTime() - new Date(r.body.restriction.startsAt).getTime()) / 86_400_000).toBeCloseTo(30, 5);
    expect((await restrict(s.cookie, s.buyer.id)).status).toBe(409);
    expect(await db.buyerPurchaseRestriction.count()).toBe(1);
    const t = await shop();
    for (const bad of [{ days: 0 }, { days: 366 }, { days: 1.5 }, { days: "7" }, { note: "가".repeat(201) }, { note: 5 }]) {
      expect((await restrict(t.cookie, t.buyer.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await db.buyerPurchaseRestriction.count({ where: { sellerId: t.seller.id } })).toBe(0);
    expect((await restrict(t.cookie, t.buyer.id, { days: 365 })).status).toBe(201);
  });

  it("다른 쇼핑몰·없는·탈퇴 회원은 404, 회원 권한이 없는 직원 403, 로그인 안 하면 401", async () => {
    const a = await shop();
    const b = await shop();
    expect((await restrict(a.cookie, b.buyer.id)).status).toBe(404);
    expect((await restrict(a.cookie, "abc")).status).toBe(404);
    expect(await db.buyerPurchaseRestriction.count({ where: { sellerId: b.seller.id } })).toBe(0);
    const none = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["ORDER_SHIPPING"] })).email);
    expect((await restrict(none, a.buyer.id)).status).toBe(403);
    expect((await restrict("", a.buyer.id)).status).toBe(401);
    expect(await withdrawBuyer(db, { sellerId: a.seller.id, buyerMemberId: a.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect((await restrict(a.cookie, a.buyer.id)).status).toBe(404);
  });

  it("?buyerMemberId로 회원 한 명의 제한만 주고(200건 밖이어도), 다른 쇼핑몰 회원 id는 빈 목록, 잘못된 값은 400", async () => {
    const s = await shop();
    const other = await createLoginBuyer(s.seller.id, s.grade.id);
    await restrict(s.cookie, s.buyer.id, { days: 3 });
    await restrict(s.cookie, other.id, { days: 3 });
    const get = async (cookie: string, qs: string) => {
      const r = await restrictionsRoute(new Request(`http://localhost:3000/api/seller/purchase-restrictions${qs}`, { headers: { host: "localhost:3000", cookie } }));
      return { status: r.status, body: await r.json() };
    };
    expect((await get(s.cookie, "")).body.restrictions).toHaveLength(2);
    const one = await get(s.cookie, `?buyerMemberId=${s.buyer.id}`);
    expect(one.body.restrictions.map((r: { buyerMemberId: string }) => r.buyerMemberId)).toEqual([s.buyer.id]);
    const t = await shop();
    expect((await get(t.cookie, `?buyerMemberId=${s.buyer.id}`)).body.restrictions).toEqual([]);
    expect((await get(s.cookie, "?buyerMemberId=abc")).status).toBe(400);
  });
});
