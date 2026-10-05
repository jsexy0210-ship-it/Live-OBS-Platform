import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as policyGet, PUT as policyPut } from "../../app/api/seller/order-notification-policy/route";
import { loginSeller } from "../../lib/server/auth/login";
import { isOrderMailEnabled } from "../../lib/server/seller-settings/orderNotificationPolicy";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 주문자 메일 켜기·끄기(/api/seller/order-notification-policy, SA-080). 기본 켬, 부분 변경, 검증, 권한, 판매자 격리, 로그 추적.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };
const URL_ = "http://localhost:3000/api/seller/order-notification-policy";

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, cookie: await cookieOf(owner.email) };
}
const get = async (cookie: string) => {
  const r = await policyGet(new Request(URL_, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const put = async (cookie: string, body: unknown) => {
  const r = await policyPut(new Request(URL_, { method: "PUT", headers: { ...H, origin: "http://localhost:3000", cookie }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const ALL_ON = { orderComplete: true, shipped: true, delivered: true, cancelRefund: true };

describe("주문자 메일 설정", () => {
  it("행이 없으면 모두 켠 상태로 준다", async () => {
    const s = await shop();
    expect(await get(s.cookie)).toMatchObject({ status: 200, body: { policy: ALL_ON } });
    expect(await isOrderMailEnabled(db, s.seller.id, "shipped")).toBe(true);
  });

  it("보낸 키만 바꾸고 나머지는 유지한다. 발송 쪽 확인 함수도 바뀐 값을 읽는다. 변경은 로그 추적에 남는다", async () => {
    const s = await shop();
    expect((await put(s.cookie, { shipped: false })).body.policy).toEqual({ ...ALL_ON, shipped: false });
    expect((await put(s.cookie, { cancelRefund: false })).body.policy).toEqual({ ...ALL_ON, shipped: false, cancelRefund: false });
    expect((await get(s.cookie)).body.policy).toEqual({ ...ALL_ON, shipped: false, cancelRefund: false });
    expect(await isOrderMailEnabled(db, s.seller.id, "shipped")).toBe(false);
    expect(await isOrderMailEnabled(db, s.seller.id, "orderComplete")).toBe(true);
    const logs = await db.auditLog.findMany({ where: { action: "order_notification_policy.update", sellerId: s.seller.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ before: ALL_ON, after: { ...ALL_ON, shipped: false } });
  });

  it("바뀐 값이 없으면 로그를 남기지 않는다", async () => {
    const s = await shop();
    await put(s.cookie, { shipped: true });
    expect(await db.auditLog.count({ where: { action: "order_notification_policy.update" } })).toBe(0);
  });

  it("빈 본문·모르는 키·boolean 아닌 값은 400이고 값이 바뀌지 않는다", async () => {
    const s = await shop();
    for (const body of [{}, [], null, { foo: true }, { shipped: "false" }, { shipped: false, extra: 1 }]) expect((await put(s.cookie, body)).status).toBe(400);
    expect((await get(s.cookie)).body.policy).toEqual(ALL_ON);
  });

  it("다른 쇼핑몰 설정은 서로 영향이 없다", async () => {
    const a = await shop();
    const b = await shop();
    await put(a.cookie, { orderComplete: false });
    expect((await get(b.cookie)).body.policy).toEqual(ALL_ON);
    expect(await isOrderMailEnabled(db, b.seller.id, "orderComplete")).toBe(true);
  });

  it("SHOP_SETTINGS 없는 직원은 403, 로그인하지 않으면 401", async () => {
    const s = await shop();
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    const c = await cookieOf(broadcaster.email);
    expect((await get(c)).status).toBe(403);
    expect((await put(c, { shipped: false })).status).toBe(403);
    expect((await get("")).status).toBe(401);
    const ok = await createSellerUser(s.seller.id, { permissions: ["SHOP_SETTINGS"] });
    expect((await put(await cookieOf(ok.email), { shipped: false })).status).toBe(200);
  });
});
