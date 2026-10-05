import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as rewardsGet } from "../../app/api/shop/[slug]/me/rewards/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const get = (slug: string, cookie?: string) =>
  rewardsGet(new Request(`http://localhost:3000/api/shop/${slug}/me/rewards`, { headers: { ...H, ...(cookie ? { cookie } : {}) } }), { params: Promise.resolve({ slug }) });

async function cookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

let key = 0;
const ledger = (sellerId: string, buyerMemberId: string, amount: number, status: "PENDING" | "SUCCEEDED" | "FAILED", testMode = false, type: "EARN" | "REVOKE" | "RANKING_BONUS" = "EARN") =>
  db.rewardLedger.create({ data: { sellerId, buyerMemberId, type, amount, status, testMode, idempotencyKey: `t:${++key}` } });

describe("구매자 적립금 잔액(GET /api/shop/{slug}/me/rewards)", () => {
  it("기록이 없으면 0, 잔액은 RewardBalance, 적립 예정은 처리 전 실지급 원장 중 들어올 금액만 합한다", async () => {
    const { seller, grade } = await createSeller();
    const a = await createLoginBuyer(seller.id, grade.id);
    const c = await cookie(seller.id, a.loginId);
    const empty = await get(seller.slug, c);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({ balance: 0, pendingEarn: 0, useEnabled: false });

    await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: a.id, balance: 3200 } });
    await ledger(seller.id, a.id, 1000, "PENDING");
    await ledger(seller.id, a.id, 500, "PENDING", false, "RANKING_BONUS");
    // 빼는 것: 시험 모드, 실패, 이미 처리됨(잔액에 있음), 회수(음수)
    await ledger(seller.id, a.id, 7000, "PENDING", true);
    await ledger(seller.id, a.id, 9000, "FAILED");
    await ledger(seller.id, a.id, 3200, "SUCCEEDED");
    await ledger(seller.id, a.id, -300, "PENDING", false, "REVOKE");
    expect(await (await get(seller.slug, c)).json()).toEqual({ balance: 3200, pendingEarn: 1500, useEnabled: false });
  });

  it("다른 회원·다른 쇼핑몰 값은 섞이지 않고, 로그인 없거나 다른 쇼핑몰 세션은 401, 없는 쇼핑몰은 404, 탈퇴 뒤 세션은 401", async () => {
    const s1 = await createSeller();
    const s2 = await createSeller();
    const a = await createLoginBuyer(s1.seller.id, s1.grade.id);
    const b = await createLoginBuyer(s1.seller.id, s1.grade.id);
    const other = await createLoginBuyer(s2.seller.id, s2.grade.id);
    await db.rewardBalance.create({ data: { sellerId: s1.seller.id, buyerMemberId: b.id, balance: 9999 } });
    await ledger(s1.seller.id, b.id, 100, "PENDING");
    await db.rewardBalance.create({ data: { sellerId: s2.seller.id, buyerMemberId: other.id, balance: 777 } });
    const ca = await cookie(s1.seller.id, a.loginId);
    expect(await (await get(s1.seller.slug, ca)).json()).toEqual({ balance: 0, pendingEarn: 0, useEnabled: false });
    expect((await get(s1.seller.slug)).status).toBe(401);
    expect((await get(s2.seller.slug, ca)).status).toBe(401);
    expect((await get("no-such-shop", ca)).status).toBe(404);

    expect(await withdrawBuyer(db, { sellerId: s1.seller.id, buyerMemberId: a.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect((await get(s1.seller.slug, ca)).status).toBe(401);
  });

  it("잠긴 쇼핑몰이어도 연다(탈퇴 전 확인)", async () => {
    const { seller, grade } = await createSeller();
    const a = await createLoginBuyer(seller.id, grade.id);
    const c = await cookie(seller.id, a.loginId);
    await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: a.id, balance: 1200 } });
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect(await (await get(seller.slug, c)).json()).toEqual({ balance: 1200, pendingEarn: 0, useEnabled: false });
  });

  it("useEnabled는 그 쇼핑몰 판매자의 적립금 실지급 켜짐 여부이고, 다른 쇼핑몰 설정과 섞이지 않는다", async () => {
    const s1 = await createSeller();
    const s2 = await createSeller();
    const a = await createLoginBuyer(s1.seller.id, s1.grade.id);
    const b = await createLoginBuyer(s2.seller.id, s2.grade.id);
    const ca = await cookie(s1.seller.id, a.loginId);
    const cb = await cookie(s2.seller.id, b.loginId);
    await db.rewardPolicy.create({ data: { sellerId: s2.seller.id, livePayoutEnabled: true } });
    expect(await (await get(s1.seller.slug, ca)).json()).toMatchObject({ useEnabled: false });
    expect(await (await get(s2.seller.slug, cb)).json()).toMatchObject({ useEnabled: true });
    await db.rewardPolicy.create({ data: { sellerId: s1.seller.id, livePayoutEnabled: false } });
    expect(await (await get(s1.seller.slug, ca)).json()).toMatchObject({ useEnabled: false });
    await db.rewardPolicy.update({ where: { sellerId: s1.seller.id }, data: { livePayoutEnabled: true } });
    expect(await (await get(s1.seller.slug, ca)).json()).toMatchObject({ useEnabled: true });
    await db.rewardPolicy.update({ where: { sellerId: s2.seller.id }, data: { livePayoutEnabled: false } });
    expect(await (await get(s2.seller.slug, cb)).json()).toMatchObject({ useEnabled: false });
    expect(await (await get(s1.seller.slug, ca)).json()).toMatchObject({ useEnabled: true });
  });
});
