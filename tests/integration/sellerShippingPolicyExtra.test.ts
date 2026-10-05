import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as policyGet, PUT as policyPut } from "../../app/api/seller/shipping-policy/route";
import { loginSeller } from "../../lib/server/auth/login";
import { getShippingPolicy } from "../../lib/server/orders/shipping";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 배송 정책의 받는 방법·발송 기한·기본 택배사(SA-061). 기본값, 부분 변경(빼면 유지), 검증, 로그 추적, 기존 배송비 칸 보존.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
const URL_ = "http://localhost:3000/api/seller/shipping-policy";
const BASE_BODY = { baseFee: 3500, freeOverAmount: 50000, remoteSurcharge: 4000, remoteZipRanges: [[63000, 63644]] };

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
  const r = await policyPut(new Request(URL_, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

describe("배송 정책 SA-061 추가 칸", () => {
  it("설정이 없으면 기본값(즉시 발송, 3일, 기본 택배사 없음)과 고를 수 있는 값을 준다", async () => {
    const s = await shop();
    const r = await get(s.cookie);
    expect(r.status).toBe(200);
    expect(r.body.policy).toMatchObject({ receiveMethods: ["IMMEDIATE"], dispatchDeadlineDays: 3, defaultCourier: null });
    expect(r.body.receiveMethodOptions).toEqual({ available: ["IMMEDIATE"], planned: ["STORAGE"] });
    expect(r.body.maxDispatchDeadlineDays).toBe(30);
    expect(Object.keys(r.body.couriers)).toContain("CJ");
  });

  it("저장하면 값이 남고, 새 칸을 빼고 보내면(예전 화면) 지금 값을 그대로 둔다. 배송비 칸과 반품·교환 배송비도 그대로다", async () => {
    const s = await shop();
    const a = await put(s.cookie, { ...BASE_BODY, returnFee: 2500, exchangeFee: 5000, dispatchDeadlineDays: 5, defaultCourier: "LOTTE", receiveMethods: ["IMMEDIATE", "IMMEDIATE"] });
    expect(a.status).toBe(200);
    expect(a.body.policy).toMatchObject({ baseFee: 3500, returnFee: 2500, exchangeFee: 5000, receiveMethods: ["IMMEDIATE"], dispatchDeadlineDays: 5, defaultCourier: "LOTTE" });
    const b = await put(s.cookie, { ...BASE_BODY, baseFee: 4000 });
    expect(b.body.policy).toMatchObject({ baseFee: 4000, returnFee: 2500, exchangeFee: 5000, receiveMethods: ["IMMEDIATE"], dispatchDeadlineDays: 5, defaultCourier: "LOTTE" });
    const c = await put(s.cookie, { ...BASE_BODY, defaultCourier: null });
    expect(c.body.policy.defaultCourier).toBeNull();
    expect((await get(s.cookie)).body.policy).toMatchObject({ dispatchDeadlineDays: 5, defaultCourier: null });
    expect(await getShippingPolicy(db, s.seller.id)).toMatchObject({ dispatchDeadlineDays: 5, defaultCourier: null, receiveMethods: ["IMMEDIATE"] });
  });

  it("잘못된 값은 400이고 저장된 값이 바뀌지 않는다", async () => {
    const s = await shop();
    await put(s.cookie, { ...BASE_BODY, dispatchDeadlineDays: 4, defaultCourier: "CJ" });
    const bad: Record<string, unknown>[] = [
      { dispatchDeadlineDays: 0 },
      { dispatchDeadlineDays: 31 },
      { dispatchDeadlineDays: 2.5 },
      { dispatchDeadlineDays: "3" },
      { defaultCourier: "UNKNOWN" },
      { defaultCourier: 5 },
      { receiveMethods: [] },
      { receiveMethods: ["STORAGE"] },
      { receiveMethods: ["IMMEDIATE", "STORAGE"] },
      { receiveMethods: "IMMEDIATE" },
      { receiveMethods: [1] },
    ];
    for (const extra of bad) expect((await put(s.cookie, { ...BASE_BODY, ...extra })).status, JSON.stringify(extra)).toBe(400);
    expect((await get(s.cookie)).body.policy).toMatchObject({ dispatchDeadlineDays: 4, defaultCourier: "CJ", receiveMethods: ["IMMEDIATE"] });
    expect((await put(s.cookie, { ...BASE_BODY, dispatchDeadlineDays: 1 })).status).toBe(200);
    expect((await put(s.cookie, { ...BASE_BODY, dispatchDeadlineDays: 30 })).status).toBe(200);
  });

  it("변경은 로그 추적에 before·after로 남고, 설정 권한이 없는 직원은 403이다", async () => {
    const s = await shop();
    await put(s.cookie, { ...BASE_BODY, defaultCourier: "HANJIN", dispatchDeadlineDays: 7 });
    const l = await db.auditLog.findFirstOrThrow({ where: { action: "shipping_policy.update", sellerId: s.seller.id } });
    expect(l).toMatchObject({ before: { dispatchDeadlineDays: 3, defaultCourier: null, receiveMethods: ["IMMEDIATE"] }, after: { dispatchDeadlineDays: 7, defaultCourier: "HANJIN" } });
    const bro = await cookieOf((await createSellerUser(s.seller.id, "BROADCASTER")).email);
    expect((await put(bro, { ...BASE_BODY, dispatchDeadlineDays: 9 })).status).toBe(403);
    expect((await get("")).status).toBe(401);
    expect((await get(s.cookie)).body.policy.dispatchDeadlineDays).toBe(7);
  });

  it("다른 쇼핑몰 설정과 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await put(a.cookie, { ...BASE_BODY, defaultCourier: "LOGEN", dispatchDeadlineDays: 10 });
    expect((await get(b.cookie)).body.policy).toMatchObject({ defaultCourier: null, dispatchDeadlineDays: 3 });
  });
});
