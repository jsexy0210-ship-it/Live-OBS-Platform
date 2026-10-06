import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as httpAdjust } from "../../app/api/seller/reward-balances/[memberId]/adjust/route";
import { ADJUST_MAX_AMOUNT, adjustRewardBalance } from "../../lib/server/rewards/adjust";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function setup(live: boolean, balance = 0) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await createBuyer(seller.id, grade.id);
  await db.rewardPolicy.create({ data: { sellerId: seller.id, livePayoutEnabled: live } });
  if (balance) await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, balance } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, buyer, ctx };
}
const grant = (amount: number, extra = {}) => ({ direction: "GRANT", amount, reason: "이벤트 보상", ...extra });
const revoke = (amount: number, extra = {}) => ({ direction: "REVOKE", amount, reason: "오지급 정정", ...extra });
const balanceOf = async (s: { seller: { id: string }; buyer: { id: string } }) => (await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } }))?.balance ?? 0;

describe("적립금 수동 조정 (SA-033)", () => {
  it("실제 지급이 켜져 있으면 바로 반영하고 원장·로그 추적에 남긴다", async () => {
    const s = await setup(true, 32400);
    const r = await adjustRewardBalance(db, s.ctx, s.buyer.id, grant(5000));
    expect(r).toMatchObject({ ok: true, replayed: false, balance: 37400, balanceAfter: 37400, entry: { type: "ADJUST", amount: 5000, status: "SUCCEEDED", reason: "이벤트 보상" } });
    expect(await balanceOf(s)).toBe(37400);
    const row = await db.rewardLedger.findFirstOrThrow({ where: { buyerMemberId: s.buyer.id } });
    expect(row).toMatchObject({ testMode: false, status: "SUCCEEDED", amount: 5000 });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "reward.adjust", targetId: s.buyer.id } });
    expect(log).toMatchObject({ reason: "이벤트 보상", sellerId: s.seller.id });
    // 회수
    const r2 = await adjustRewardBalance(db, s.ctx, s.buyer.id, revoke(7400));
    expect(r2).toMatchObject({ ok: true, balance: 30000, entry: { amount: -7400 } });
  });

  it("실제 지급이 꺼져 있으면 대기로만 남기고 잔액은 그대로다", async () => {
    const s = await setup(false, 1000);
    const r = await adjustRewardBalance(db, s.ctx, s.buyer.id, grant(5000));
    expect(r).toMatchObject({ ok: true, balance: 1000, balanceAfter: null, entry: { status: "PENDING", amount: 5000 } });
    expect(await balanceOf(s)).toBe(1000);
    expect((await db.rewardLedger.findFirstOrThrow({ where: { buyerMemberId: s.buyer.id } })).testMode).toBe(true);
  });

  it("경계값: 회수는 잔액까지, 넘으면 거부(음수 잔액 금지), 0원·소수·한도 초과·사유 없음은 400", async () => {
    const s = await setup(true, 1000);
    expect(await adjustRewardBalance(db, s.ctx, s.buyer.id, revoke(1001))).toEqual({ ok: false, reason: "reward_adjust_insufficient" });
    expect(await adjustRewardBalance(db, s.ctx, s.buyer.id, revoke(1000))).toMatchObject({ ok: true, balance: 0 });
    expect(await adjustRewardBalance(db, s.ctx, s.buyer.id, revoke(1))).toEqual({ ok: false, reason: "reward_adjust_insufficient" });
    for (const bad of [grant(0), grant(-5), grant(1.5), grant(ADJUST_MAX_AMOUNT + 1), grant(100, { reason: "  " }), grant(100, { reason: "가".repeat(201) }), { direction: "X", amount: 5, reason: "a" }, grant(100, { requestId: "no" }), null]) {
      expect(await adjustRewardBalance(db, s.ctx, s.buyer.id, bad)).toEqual({ ok: false, reason: "invalid_reward_adjust" });
    }
    expect(await adjustRewardBalance(db, s.ctx, s.buyer.id, grant(ADJUST_MAX_AMOUNT))).toMatchObject({ ok: true, balance: ADJUST_MAX_AMOUNT });
    expect(await db.rewardLedger.count({ where: { buyerMemberId: s.buyer.id } })).toBe(2); // 거부된 요청은 원장을 남기지 않는다
  });

  it("동시에 회수해도 잔액이 음수가 되지 않고 원장 합계와 잔액이 일치한다", async () => {
    const s = await setup(true, 1000);
    const rs = await Promise.all(Array.from({ length: 8 }, () => adjustRewardBalance(db, s.ctx, s.buyer.id, revoke(300))));
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "reward_adjust_insufficient")).toBe(true);
    expect(await balanceOf(s)).toBe(100);
    const sum = await db.rewardLedger.aggregate({ where: { buyerMemberId: s.buyer.id, status: "SUCCEEDED" }, _sum: { amount: true } });
    expect(1000 + (sum._sum.amount ?? 0)).toBe(100);
  });

  it("동시 지급·회수가 섞여도 잔액 = 시작 + 성공한 조정 합계", async () => {
    const s = await setup(true, 500);
    const reqs = Array.from({ length: 12 }, (_, i) => (i % 2 ? revoke(200) : grant(100)));
    const rs = await Promise.all(reqs.map((b) => adjustRewardBalance(db, s.ctx, s.buyer.id, b)));
    const applied = rs.flatMap((r) => (r.ok ? [r.entry.amount] : []));
    expect(await balanceOf(s)).toBe(500 + applied.reduce((a, b) => a + b, 0));
    expect(await balanceOf(s)).toBeGreaterThanOrEqual(0);
  });

  it("같은 requestId 재시도는 한 번만 반영하고, 다른 내용이면 conflict", async () => {
    const s = await setup(true, 0);
    const requestId = "7f3c1e2a-5b6d-4e8f-9a0b-1c2d3e4f5a6b";
    const a = await adjustRewardBalance(db, s.ctx, s.buyer.id, grant(500, { requestId }));
    const b = await adjustRewardBalance(db, s.ctx, s.buyer.id, grant(500, { requestId }));
    expect(a).toMatchObject({ ok: true, replayed: false });
    expect(b).toMatchObject({ ok: true, replayed: true, balance: 500 });
    expect(await balanceOf(s)).toBe(500);
    expect(await adjustRewardBalance(db, s.ctx, s.buyer.id, grant(900, { requestId }))).toEqual({ ok: false, reason: "reward_adjust_conflict" });
    const racing = await Promise.all([1, 2, 3].map(() => adjustRewardBalance(db, s.ctx, s.buyer.id, grant(10, { requestId: "11111111-2222-4333-8444-555555555555" }))));
    expect(racing.every((r) => r.ok)).toBe(true);
    expect(await balanceOf(s)).toBe(510);
  });

  it("다른 쇼핑몰·탈퇴 회원은 대상이 아니다", async () => {
    const a = await setup(true, 100);
    const other = await setup(true, 100);
    expect(await adjustRewardBalance(db, a.ctx, other.buyer.id, grant(10))).toEqual({ ok: false, reason: "reward_adjust_member_not_found" });
    expect(await adjustRewardBalance(db, a.ctx, "not-uuid", grant(10))).toEqual({ ok: false, reason: "reward_adjust_member_not_found" });
    await db.buyerMember.update({ where: { id: a.buyer.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    expect(await adjustRewardBalance(db, a.ctx, a.buyer.id, grant(10))).toEqual({ ok: false, reason: "reward_adjust_member_not_found" });
    expect(await balanceOf(other)).toBe(100);
  });

  it("권한 없는 직원은 조정할 수 없다", async () => {
    const s = await setup(true, 100);
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    await expect(adjustRewardBalance(db, staff, s.buyer.id, grant(10))).rejects.toMatchObject({ status: 403 });
    expect(await balanceOf(s)).toBe(100);
  });

  it("HTTP: 인증 없으면 401, 잘못된 값이면 400 메시지", async () => {
    const s = await setup(true, 0);
    const req = (body: unknown) => new Request("http://localhost/api/seller/reward-balances/x/adjust", { method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await httpAdjust(req(grant(10)), { params: Promise.resolve({ memberId: s.buyer.id }) });
    expect(r.status).toBe(401);
  });
});
