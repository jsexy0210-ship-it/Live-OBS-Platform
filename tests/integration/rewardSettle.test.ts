import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listRewardLedger } from "../../lib/server/seller-settings/rewardLedger";
import { adjustRewardBalance } from "../../lib/server/rewards/adjust";
import { listLivePayoutHistory, readLivePayoutConditions } from "../../lib/server/rewards/livePayoutAdmin";
import { updateRewardPolicy } from "../../lib/server/rewards/policyAdmin";
import { continueSettlement, retryFailedRewards, settleAllLiveSellers, settlePendingRewards } from "../../lib/server/rewards/settle";
import { updateLivePayout } from "../../lib/server/seller-settings/rewardLivePayout";
import type { TenantContext } from "../../lib/server/tenant/context";
import { prisma } from "../../lib/server/db";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 대기 적립 원장 지급 처리(SA-034 켜기 일괄 지급·SA-032 재시도): 원장·잔액 일치, 동시성, 멱등, 권한, 판매자 격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

let n = 0;
async function setup(live = true) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  await db.rewardPolicy.create({ data: { sellerId: seller.id, livePayoutEnabled: live } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, ctx };
}
type S = Awaited<ReturnType<typeof setup>>;
const member = (s: S) => createBuyer(s.seller.id, s.grade.id);
let tick = 0;
function pending(s: S, memberId: string, amount: number, type: "EARN" | "REVOKE" | "ADJUST" | "RANKING_BONUS" = amount < 0 ? "REVOKE" : "EARN") {
  return db.rewardLedger.create({
    data: { sellerId: s.seller.id, buyerMemberId: memberId, type, amount, status: "PENDING", testMode: true, idempotencyKey: `t${n++}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, tick++)) },
  });
}
const balanceOf = async (s: S, memberId: string) => (await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: memberId } } }))?.balance ?? 0;
async function expectConsistent(s: S, memberId: string) {
  const sum = await db.rewardLedger.aggregate({ where: { sellerId: s.seller.id, buyerMemberId: memberId, status: "SUCCEEDED" }, _sum: { amount: true } });
  const bal = await balanceOf(s, memberId);
  expect(bal).toBe(sum._sum.amount ?? 0);
  expect(bal).toBeGreaterThanOrEqual(0);
}
const run = (s: S, o: Partial<Parameters<typeof settlePendingRewards>[1]> = {}) => settlePendingRewards(db, { sellerId: s.seller.id, trigger: "continue", ...o });

describe("대기 적립 지급 처리", () => {
  it("실제 지급을 켜면 대기분이 일괄 지급되고 원장·잔액이 일치하며, 켠 이력에 지급 건수·금액이 남는다", async () => {
    const s = await setup(false);
    const a = await member(s);
    const b = await member(s);
    await pending(s, a.id, 1000);
    await pending(s, a.id, 500, "RANKING_BONUS");
    await pending(s, b.id, 2000);
    expect((await run(s)).skipped).toBe("not_live");
    expect(await balanceOf(s, a.id)).toBe(0);
    const before = await readLivePayoutConditions(db, s.ctx);
    expect(before.pending).toEqual({ count: 3, amount: 3500 });

    const on = await updateLivePayout(db, s.ctx, { enabled: true, confirm: true });
    expect(on).toMatchObject({ ok: true, changed: true, settlement: { settled: 3, settledAmount: 3500, failed: 0, remaining: 0 } });
    expect(await balanceOf(s, a.id)).toBe(1500);
    expect(await balanceOf(s, b.id)).toBe(2000);
    await expectConsistent(s, a.id);
    await expectConsistent(s, b.id);
    const rows = await db.rewardLedger.findMany({ where: { sellerId: s.seller.id } });
    expect(rows.every((r) => r.status === "SUCCEEDED" && r.testMode === false && r.processedAt)).toBe(true);

    const off = await updateLivePayout(db, s.ctx, { enabled: false });
    expect(off).toMatchObject({ ok: true, changed: true, settlement: null });
    const h = await listLivePayoutHistory(db, s.ctx, {});
    expect(h.ok && h.history.map((x) => [x.enabled, x.settled])).toEqual([[false, null], [true, { count: 3, amount: 3500 }]]);
    // 이미 켜져 있던 값을 다시 켜도 지급을 다시 하지 않는다
    expect(await updateLivePayout(db, s.ctx, { enabled: true, confirm: true })).toMatchObject({ changed: true });
    expect(await balanceOf(s, a.id)).toBe(1500);
  });

  it("같은 회원의 적립 뒤 회수는 만든 순서대로 반영되고, 잔액이 모자란 회수는 실패로 남는다(음수 잔액 없음)", async () => {
    const s = await setup();
    const m = await member(s);
    await pending(s, m.id, 1000);
    const r1 = await pending(s, m.id, -300);
    const r2 = await pending(s, m.id, -5000);
    const r3 = await pending(s, m.id, 200);
    const res = await run(s);
    expect(res).toMatchObject({ settled: 3, settledAmount: 1200, revokedAmount: 300, failed: 1, remaining: 0 });
    expect(await balanceOf(s, m.id)).toBe(900);
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({ status: "FAILED", failureReason: "insufficient_balance" });
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: r3.id } })).toMatchObject({ status: "SUCCEEDED" });
    await expectConsistent(s, m.id);
  });

  it("같은 시각에 만든 줄도 처리한 순서가 남아 잔액(후)이 어긋나지 않는다(회수 id가 적립 id보다 작아도)", async () => {
    const s = await setup();
    const m = await member(s);
    const at = new Date("2026-10-01T00:00:00Z");
    const base = { sellerId: s.seller.id, buyerMemberId: m.id, status: "PENDING" as const, testMode: true, createdAt: at };
    // 적립을 먼저 만들었지만 id는 회수가 더 작다(처리 순서는 createdAt 순이라 적립이 먼저 적용된다)
    await db.rewardLedger.create({ data: { ...base, id: "ffffffff-0000-4000-8000-000000000001", type: "EARN", amount: 1000, idempotencyKey: "same-earn", createdAt: new Date(at.getTime() - 1000) } });
    await db.rewardLedger.create({ data: { ...base, id: "00000000-0000-4000-8000-000000000001", type: "REVOKE", amount: -300, idempotencyKey: "same-revoke" } });
    await run(s);
    const r = await listRewardLedger(db, s.ctx, {});
    if (!r.ok) throw new Error("list");
    const by = new Map(r.entries.map((e) => [e.amount, e]));
    expect(by.get(1000)?.balanceAfter).toBe(1000);
    expect(by.get(-300)?.balanceAfter).toBe(700);
    expect((by.get(1000)!.processedAt as Date).getTime()).toBeLessThan((by.get(-300)!.processedAt as Date).getTime());
    await expectConsistent(s, m.id);
  });

  it("두 번째 실행·동시 실행에도 같은 줄을 두 번 적용하지 않는다(멱등)", async () => {
    const s = await setup();
    const ms = await Promise.all([member(s), member(s), member(s)]);
    for (const m of ms) for (let i = 0; i < 5; i++) await pending(s, m.id, 100);
    const results = await Promise.all(Array.from({ length: 6 }, () => run(s)));
    expect(results.reduce((a, r) => a + r.settled, 0)).toBe(15);
    for (const m of ms) {
      expect(await balanceOf(s, m.id)).toBe(500);
      await expectConsistent(s, m.id);
    }
    expect(await run(s)).toMatchObject({ settled: 0, failed: 0, remaining: 0 });
    expect(await db.auditLog.count({ where: { action: "reward.settle", sellerId: s.seller.id } })).toBeGreaterThan(0);
  });

  it("지급 처리와 동시에 수동 회수·지급을 해도 잔액 = 성공 원장 합계, 음수 없음", async () => {
    const s = await setup();
    const m = await member(s);
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, balance: 1000 } });
    await db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, type: "ADJUST", amount: 1000, status: "SUCCEEDED", testMode: false, idempotencyKey: "seed", processedAt: new Date(), reason: "seed" } });
    for (let i = 0; i < 6; i++) await pending(s, m.id, i % 2 ? -400 : 300);
    const jobs: Promise<unknown>[] = [run(s), run(s)];
    for (let i = 0; i < 6; i++) jobs.push(adjustRewardBalance(db, s.ctx, m.id, i % 2 ? { direction: "REVOKE", amount: 350, reason: "r" } : { direction: "GRANT", amount: 200, reason: "g" }));
    await Promise.all(jobs);
    await run(s);
    await expectConsistent(s, m.id);
    expect(await db.rewardLedger.count({ where: { sellerId: s.seller.id, status: "PENDING" } })).toBe(0);
  });

  it("탈퇴 회원 줄은 실패로 닫고 잔액에 넣지 않는다", async () => {
    const s = await setup();
    const m = await member(s);
    const r = await pending(s, m.id, 700);
    await db.buyerMember.update({ where: { id: m.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    expect(await run(s)).toMatchObject({ settled: 0, failed: 1 });
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "FAILED", failureReason: "member_withdrawn" });
    expect(await balanceOf(s, m.id)).toBe(0);
  });

  it("회원 단위로 나눠 처리하고(remaining) 이어서 부르면 끝난다", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await pending(s, (await member(s)).id, 100);
    const first = await run(s, { memberLimit: 2 });
    expect(first).toMatchObject({ settled: 2, remaining: 3 });
    const next = await continueSettlement(db, s.ctx);
    expect(next).toMatchObject({ settled: 3, remaining: 0 });
    expect((await db.rewardBalance.aggregate({ where: { sellerId: s.seller.id }, _sum: { balance: true } }))._sum.balance).toBe(500);
  });

  it("실패 재시도: 잔액을 채운 뒤 다시 하면 성공하고, 탈퇴로 닫힌 줄·다른 쇼핑몰 줄·성공 줄은 바뀌지 않는다", async () => {
    const s = await setup();
    const m = await member(s);
    const gone = await member(s);
    const fail = await pending(s, m.id, -800);
    const done = await pending(s, m.id, 100);
    const wd = await pending(s, gone.id, 50);
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    await run(s);
    expect((await db.rewardLedger.findUniqueOrThrow({ where: { id: fail.id } })).status).toBe("FAILED");
    // 잔액이 모자란 채로 재시도하면 다시 실패
    expect(await retryFailedRewards(db, s.ctx, {})).toMatchObject({ ok: true, requested: 1, result: { settled: 0, failed: 1 } });
    await adjustRewardBalance(db, s.ctx, m.id, { direction: "GRANT", amount: 1000, reason: "보충" });
    const other = await setup();
    const om = await member(other);
    const ofail = await pending(other, om.id, -10);
    await run(other);
    const r = await retryFailedRewards(db, s.ctx, { ids: [fail.id, done.id, wd.id, ofail.id] });
    expect(r).toMatchObject({ ok: true, result: { settled: 1, failed: 0 } });
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: fail.id } })).toMatchObject({ status: "SUCCEEDED", failureReason: null });
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: wd.id } })).toMatchObject({ status: "FAILED", failureReason: "member_withdrawn" });
    expect((await db.rewardLedger.findUniqueOrThrow({ where: { id: ofail.id } })).status).toBe("FAILED");
    expect(await balanceOf(s, m.id)).toBe(1000 + 100 - 800);
    await expectConsistent(s, m.id);
    // 성공한 줄을 다시 재시도해도 두 번 반영되지 않는다
    await retryFailedRewards(db, s.ctx, { ids: [fail.id] });
    expect(await balanceOf(s, m.id)).toBe(300);
    expect(await retryFailedRewards(db, s.ctx, { ids: ["x"] })).toEqual({ ok: false, reason: "invalid_retry" });
    expect(await retryFailedRewards(db, s.ctx, { ids: [] })).toEqual({ ok: false, reason: "invalid_retry" });
  });

  it("실제 지급이 꺼져 있으면 재시도·이어서 처리가 아무것도 바꾸지 않는다", async () => {
    const s = await setup(false);
    const m = await member(s);
    const fail = await db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, type: "REVOKE", amount: -5, status: "FAILED", failureReason: "insufficient_balance", testMode: true, idempotencyKey: "f1", processedAt: new Date() } });
    expect(await retryFailedRewards(db, s.ctx, {})).toMatchObject({ result: { skipped: "not_live", settled: 0 } });
    expect((await db.rewardLedger.findUniqueOrThrow({ where: { id: fail.id } })).status).toBe("FAILED");
    expect(await continueSettlement(db, s.ctx)).toMatchObject({ skipped: "not_live" });
  });

  it("판매자 격리: 한 쇼핑몰 처리가 다른 쇼핑몰 대기분을 건드리지 않고, 정기 처리는 켜진 쇼핑몰만 처리한다", async () => {
    const a = await setup(true);
    const b = await setup(false);
    const c = await setup(true);
    const [ma, mb, mc] = [await member(a), await member(b), await member(c)];
    await pending(a, ma.id, 100);
    await pending(b, mb.id, 200);
    await pending(c, mc.id, 300);
    expect(await run(a)).toMatchObject({ settled: 1 });
    expect(await balanceOf(c, mc.id)).toBe(0);
    expect(await settleAllLiveSellers(db)).toBe(1);
    expect(await balanceOf(c, mc.id)).toBe(300);
    expect(await balanceOf(b, mb.id)).toBe(0);
    expect((await db.rewardLedger.findFirstOrThrow({ where: { buyerMemberId: mb.id } })).status).toBe("PENDING");
  });

  it("권한 없는 직원은 이어서 처리·재시도할 수 없다", async () => {
    const s = await setup();
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    await expect(continueSettlement(db, staff)).rejects.toMatchObject({ status: 403 });
    await expect(retryFailedRewards(db, staff, {})).rejects.toMatchObject({ status: 403 });
    await expect(readLivePayoutConditions(db, staff)).rejects.toMatchObject({ status: 403 });
  });

  it("켜기 조건: 정책·최근 실패, 정책을 저장하면 충족", async () => {
    const s = await setup(false);
    const c1 = await readLivePayoutConditions(db, s.ctx);
    expect(c1).toMatchObject({ canEnable: false, conditions: [{ key: "policy", met: false }, { key: "noRecentFailures", met: true }, { key: "subscription", met: true }] });
    await updateRewardPolicy(db, s.ctx, { rates: { [s.grade.id]: { card: 1 } } });
    expect((await readLivePayoutConditions(db, s.ctx)).canEnable).toBe(true);
    const m = await member(s);
    await db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, type: "REVOKE", amount: -50, status: "FAILED", failureReason: "insufficient_balance", testMode: false, idempotencyKey: "f2", processedAt: new Date() } });
    await db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, type: "EARN", amount: 9, status: "FAILED", failureReason: "member_withdrawn", testMode: false, idempotencyKey: "f3", processedAt: new Date() } });
    const c2 = await readLivePayoutConditions(db, s.ctx);
    expect(c2).toMatchObject({ canEnable: false, recentFailed: { count: 1, amount: 50 } });
  });
});
