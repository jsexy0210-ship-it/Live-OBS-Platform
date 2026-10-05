import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as payoutGet, PUT as payoutPut } from "../../app/api/seller/reward-live-payout/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 적립금 실지급 스위치(/api/seller/reward-live-payout, SA-034). 대표자만 변경, 켤 때 confirm 필수, 로그 추적, 동시 변경, 판매자 격리.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
const URL_ = "http://localhost:3000/api/seller/reward-live-payout";

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner, cookie: await cookieOf(owner.email) };
}
const get = async (cookie: string) => {
  const r = await payoutGet(new Request(URL_, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const put = async (cookie: string, body: unknown) => {
  const r = await payoutPut(new Request(URL_, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const logs = (sellerId: string) => db.auditLog.findMany({ where: { action: "reward_policy.live_payout", sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("적립금 실지급 스위치", () => {
  it("기본은 꺼짐이고 기록은 null이다", async () => {
    const s = await shop();
    expect(await get(s.cookie)).toMatchObject({ status: 200, body: { livePayout: { enabled: false, changedAt: null, changedByName: null } } });
  });

  it("켤 때 confirm: true가 없으면 400이고 아무것도 바뀌지 않는다. 있으면 켜지고 시각·변경자 이름·로그가 남는다", async () => {
    const s = await shop();
    for (const body of [{ enabled: true }, { enabled: true, confirm: false }, { enabled: true, confirm: "true" }]) {
      const r = await put(s.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await put(s.cookie, { enabled: true })).body.error).toBe("live_payout_confirm_required");
    expect(await db.rewardPolicy.count()).toBe(0);
    expect(await logs(s.seller.id)).toHaveLength(0);
    const r = await put(s.cookie, { enabled: true, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.livePayout).toMatchObject({ enabled: true, changedByName: s.owner.name });
    expect(r.body.livePayout.changedAt).toBeTruthy();
    const row = await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    expect(row).toMatchObject({ livePayoutEnabled: true, livePayoutChangedBy: s.owner.id });
    const l = await logs(s.seller.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ actorId: s.owner.id, before: { enabled: false }, after: { enabled: true } });
  });

  it("끌 때는 confirm이 필요 없고, 같은 값을 다시 보내면 켠 시각·변경자·로그가 그대로다", async () => {
    const s = await shop();
    await put(s.cookie, { enabled: true, confirm: true });
    const first = await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    const again = await put(s.cookie, { enabled: true, confirm: true });
    expect(again.status).toBe(200);
    expect((await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).livePayoutChangedAt).toEqual(first.livePayoutChangedAt);
    expect(await logs(s.seller.id)).toHaveLength(1);
    expect((await put(s.cookie, { enabled: false })).body.livePayout.enabled).toBe(false);
    expect((await put(s.cookie, { enabled: false })).status).toBe(200); // 이미 꺼짐
    const l = await logs(s.seller.id);
    expect(l).toHaveLength(2);
    expect(l[1]).toMatchObject({ before: { enabled: true }, after: { enabled: false } });
  });

  it("다른 설정 값(지급 시점·비율)은 건드리지 않는다", async () => {
    const s = await shop();
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, earnTiming: "ON_PAYMENT", rankingBonusEnabled: true, rankingBonusAmount: 300 } });
    await put(s.cookie, { enabled: true, confirm: true });
    expect(await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).toMatchObject({ earnTiming: "ON_PAYMENT", rankingBonusEnabled: true, rankingBonusAmount: 300, livePayoutEnabled: true });
  });

  it("잘못된 본문은 400이다", async () => {
    const s = await shop();
    for (const body of [{}, [], null, { enabled: "true" }, { enabled: 1 }, { enabled: false, confirm: "x" }, { confirm: true }]) expect((await put(s.cookie, body)).status, JSON.stringify(body)).toBe(400);
    expect(await db.rewardPolicy.count()).toBe(0);
  });

  it("직원은 MEMBER_POINTS·SHOP_SETTINGS가 있어도 변경은 403, 조회는 MEMBER_POINTS만 허용한다. 로그인하지 않으면 401", async () => {
    const s = await shop();
    const staff = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["MEMBER_POINTS", "SHOP_SETTINGS"] })).email);
    expect((await put(staff, { enabled: true, confirm: true })).status).toBe(403);
    expect((await get(staff)).status).toBe(200);
    const none = await cookieOf((await createSellerUser(s.seller.id, "BROADCASTER")).email);
    expect((await get(none)).status).toBe(403);
    expect((await put(none, { enabled: true, confirm: true })).status).toBe(403);
    expect((await get("")).status).toBe(401);
    expect((await put("", { enabled: true, confirm: true })).status).toBe(401);
    expect(await db.rewardPolicy.count()).toBe(0);
    expect(await logs(s.seller.id)).toHaveLength(0);
  });

  it("다른 쇼핑몰 대표자의 설정에 영향을 주지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await put(a.cookie, { enabled: true, confirm: true });
    expect((await get(b.cookie)).body.livePayout.enabled).toBe(false);
    expect(await db.rewardPolicy.findUnique({ where: { sellerId: b.seller.id } })).toBeNull();
  });

  it("동시에 켜고 끄는 요청이 와도 마지막 값과 로그 수가 일치한다(로그 = 실제로 바뀐 횟수)", async () => {
    const s = await shop();
    const calls = Array.from({ length: 12 }, (_, i) => put(s.cookie, i % 2 === 0 ? { enabled: true, confirm: true } : { enabled: false }));
    const rs = await Promise.all(calls);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const row = await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    const l = await logs(s.seller.id);
    expect(l.length).toBeGreaterThan(0);
    // 로그는 실제 전환만 남으므로 앞뒤가 이어지고(before = 직전 after) 마지막 after가 현재 값이다
    for (let i = 1; i < l.length; i++) expect((l[i].before as { enabled: boolean }).enabled).toBe((l[i - 1].after as { enabled: boolean }).enabled);
    expect((l[0].before as { enabled: boolean }).enabled).toBe(false);
    expect((l[l.length - 1].after as { enabled: boolean }).enabled).toBe(row.livePayoutEnabled);
    for (const x of l) expect((x.before as { enabled: boolean }).enabled).not.toBe((x.after as { enabled: boolean }).enabled);
  });
});
