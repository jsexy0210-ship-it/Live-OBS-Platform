import type { RewardLedgerStatus, RewardLedgerType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expireDormantRewards } from "../../lib/server/rewards/expire";
import { createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const NOW = new Date("2029-10-03T03:00:00.000Z");
// NOW 기준 정확히 3년 전(이 시각의 적립은 소멸 대상)
const THREE_YEARS_AGO = new Date("2026-10-03T03:00:00.000Z");
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

async function member(balance: number) {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, balance } });
  let n = 0;
  const ledger = (type: RewardLedgerType, amount: number, createdAt: Date, extra: { status?: RewardLedgerStatus; testMode?: boolean } = {}) =>
    db.rewardLedger.create({
      data: { sellerId: seller.id, buyerMemberId: buyer.id, type, amount, status: extra.status ?? "SUCCEEDED", testMode: extra.testMode ?? false, idempotencyKey: `t:${++n}`, createdAt },
    });
  const bal = async () => (await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } } })).balance;
  return { seller, buyer, ledger, bal };
}

describe("적립금 3년 소멸", () => {
  it("마지막 적립일부터 3년이 지나면 남은 잔액을 소멸 원장으로 남기고 0으로 만든다. 다시 돌려도 같다", async () => {
    const m = await member(700);
    await m.ledger("EARN", 500, ms(THREE_YEARS_AGO, -10 * 86400_000));
    await m.ledger("EARN", 200, THREE_YEARS_AGO);
    expect(await expireDormantRewards(db, { now: NOW })).toEqual({ done: [{ sellerId: m.seller.id, buyerMemberId: m.buyer.id, expiredPoints: 700 }], failed: [] });
    expect(await m.bal()).toBe(0);
    expect(await db.rewardLedger.findMany({ where: { buyerMemberId: m.buyer.id, type: "EXPIRE" } })).toMatchObject([
      { amount: -700, status: "SUCCEEDED", testMode: false, orderId: null, createdAt: NOW, processedAt: NOW },
    ]);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "reward.expire", targetId: m.buyer.id } })).toMatchObject({
      actorType: "SYSTEM",
      sellerId: m.seller.id,
      reason: "no_earn_3_years",
      after: { expiredPoints: 700, lastEarnAt: THREE_YEARS_AGO.toISOString() },
    });
    expect(await expireDormantRewards(db, { now: NOW })).toEqual({ done: [], failed: [] });
    expect(await expireDormantRewards(db, { now: ms(NOW, 1000) })).toEqual({ done: [], failed: [] });
    expect(await db.rewardLedger.count({ where: { buyerMemberId: m.buyer.id, type: "EXPIRE" } })).toBe(1);
  });

  it("3년이 1ms라도 안 됐거나, 그사이 새로 적립(지급 대기·랭킹 보너스·수동 지급 포함)했으면 소멸하지 않는다", async () => {
    const early = await member(100);
    await early.ledger("EARN", 100, ms(THREE_YEARS_AGO, 1));
    const pending = await member(100);
    await pending.ledger("EARN", 100, ms(THREE_YEARS_AGO, -86400_000));
    await pending.ledger("EARN", 50, ms(NOW, -86400_000), { status: "PENDING" });
    const bonus = await member(100);
    await bonus.ledger("EARN", 100, ms(THREE_YEARS_AGO, -86400_000));
    await bonus.ledger("RANKING_BONUS", 10, ms(NOW, -86400_000));
    const adjust = await member(100);
    await adjust.ledger("EARN", 100, ms(THREE_YEARS_AGO, -86400_000));
    await adjust.ledger("ADJUST", 10, ms(NOW, -86400_000));
    expect(await expireDormantRewards(db, { now: NOW })).toEqual({ done: [], failed: [] });
    for (const m of [early, pending, bonus, adjust]) expect(await m.bal()).toBe(100);
  });

  it("실패·시험(testMode) 적립, 회수·사용·차감 조정은 적립으로 보지 않아 3년 기준일을 늦추지 않는다", async () => {
    const m = await member(300);
    await m.ledger("EARN", 300, ms(THREE_YEARS_AGO, -86400_000));
    await m.ledger("EARN", 100, ms(NOW, -86400_000), { status: "FAILED" });
    await m.ledger("EARN", 100, ms(NOW, -86400_000), { testMode: true });
    await m.ledger("REVOKE", -10, ms(NOW, -86400_000));
    await m.ledger("USE", -10, ms(NOW, -86400_000));
    await m.ledger("ADJUST", -10, ms(NOW, -86400_000));
    expect((await expireDormantRewards(db, { now: NOW })).done).toEqual([{ sellerId: m.seller.id, buyerMemberId: m.buyer.id, expiredPoints: 300 }]);
    expect(await m.bal()).toBe(0);
  });

  it("잔액이 0이거나 적립 기록이 없는 잔액은 건드리지 않고, 한도(limit)만큼만 오래된 순으로 처리한다", async () => {
    const zero = await member(0);
    await zero.ledger("EARN", 100, ms(THREE_YEARS_AGO, -86400_000));
    const noEarn = await member(100);
    const older = await member(100);
    await older.ledger("EARN", 100, ms(THREE_YEARS_AGO, -2 * 86400_000));
    const newer = await member(100);
    await newer.ledger("EARN", 100, ms(THREE_YEARS_AGO, -86400_000));
    expect((await expireDormantRewards(db, { now: NOW, limit: 1 })).done.map((d) => d.buyerMemberId)).toEqual([older.buyer.id]);
    expect((await expireDormantRewards(db, { now: NOW })).done.map((d) => d.buyerMemberId)).toEqual([newer.buyer.id]);
    expect(await noEarn.bal()).toBe(100);
    expect(await db.rewardLedger.count({ where: { type: "EXPIRE", buyerMemberId: { in: [zero.buyer.id, noEarn.buyer.id] } } })).toBe(0);
  });
});
