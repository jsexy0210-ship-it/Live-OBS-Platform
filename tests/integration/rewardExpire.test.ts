import type { RewardLedgerStatus, RewardLedgerType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimRewardExpiryNotices, expireDormantRewards, markRewardExpiryNoticeFailed, markRewardExpiryNoticeSent } from "../../lib/server/rewards/expire";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

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

  it("[경합] 소멸이 잔액 잠금을 기다리는 사이 새 적립이 커밋되면 소멸하지 않는다(잠근 뒤 마지막 적립일을 새로 읽음)", async () => {
    const m = await member(300);
    await m.ledger("EARN", 300, THREE_YEARS_AGO);
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((r) => (locked = r));
    // 적립 트랜잭션: 잔액 행을 잠그고 새 적립 원장·잔액 증가를 넣은 채 소멸이 잠금을 기다릴 때까지 커밋하지 않는다
    const earn = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "RewardBalance" WHERE "sellerId" = ${m.seller.id}::uuid AND "buyerMemberId" = ${m.buyer.id}::uuid FOR UPDATE`;
      await tx.rewardLedger.create({
        data: { sellerId: m.seller.id, buyerMemberId: m.buyer.id, type: "EARN", amount: 50, status: "SUCCEEDED", testMode: false, idempotencyKey: "t:race", createdAt: NOW },
      });
      await tx.rewardBalance.update({ where: { sellerId_buyerMemberId: { sellerId: m.seller.id, buyerMemberId: m.buyer.id } }, data: { balance: { increment: 50 } } });
      locked();
      await hold;
    }, { timeout: 15_000 });
    await holding;
    // 후보는 커밋 전 상태로 고르고(옛 적립일), 트랜잭션에서 잔액 잠금을 기다린다
    const expiring = expireDormantRewards(db, { now: NOW });
    for (let i = 0; i < 100; i++) {
      const [w] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (w.n > 0n) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await earn;
    expect(await expiring).toEqual({ done: [], failed: [] });
    expect(await m.bal()).toBe(350);
    expect(await db.rewardLedger.count({ where: { buyerMemberId: m.buyer.id, type: "EXPIRE" } })).toBe(0);
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

describe("적립금 소멸 30일 전 안내 대상 잡기", () => {
  const DAY = 86400_000;
  // 마지막 적립이 NOW 기준 (3년 - d일) 전이면 소멸까지 d일 남음
  const earnedLeft = (days: number) => ms(THREE_YEARS_AGO, days * DAY);

  it("소멸 30일 전부터 소멸 전까지인 회원을 소멸 예정 금액·시각과 함께 한 번만 잡는다", async () => {
    const in30 = await member(500);
    await in30.ledger("EARN", 500, earnedLeft(30));
    const in31 = await member(500);
    await in31.ledger("EARN", 500, earnedLeft(31));
    const past = await member(500);
    await past.ledger("EARN", 500, earnedLeft(0));
    const zero = await member(0);
    await zero.ledger("EARN", 500, earnedLeft(10));
    const claimed = await claimRewardExpiryNotices(db, { now: NOW });
    expect(claimed).toEqual([
      { noticeId: expect.any(String), idempotencyKey: claimed[0]?.noticeId, sellerId: in30.seller.id, buyerMemberId: in30.buyer.id, amount: 500, expiresAt: ms(NOW, 30 * DAY), attempts: 1 },
    ]);
    // 같은 소멸 예정은 다시 잡지 않는다(보내는 중이어도, 보낸 뒤에도)
    expect(await claimRewardExpiryNotices(db, { now: ms(NOW, 60_000) })).toEqual([]);
    expect(await markRewardExpiryNoticeSent(db, claimed[0])).toBe(true);
    expect(await claimRewardExpiryNotices(db, { now: ms(NOW, 3600_000) })).toEqual([]);
  });

  it("탈퇴하면 소멸 안내 기록을 지우고(잔액 0) 다시 잡지 않는다", async () => {
    const m = await member(500);
    await m.ledger("EARN", 500, earnedLeft(10));
    expect(await claimRewardExpiryNotices(db, { now: NOW })).toHaveLength(1);
    expect(await withdrawBuyer(db, { sellerId: m.seller.id, buyerMemberId: m.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.rewardExpiryNotice.count({ where: { buyerMemberId: m.buyer.id } })).toBe(0);
    expect(await m.bal()).toBe(0);
    expect(await claimRewardExpiryNotices(db, { now: ms(NOW, 3600_000) })).toEqual([]);
  });

  it("실패하면 시도 3번까지 다시 잡고, 그사이 새로 적립했으면 잡지 않으며 새 기준으로 다음에 다시 안내한다", async () => {
    const m = await member(500);
    await m.ledger("EARN", 500, earnedLeft(20));
    let [c] = await claimRewardExpiryNotices(db, { now: NOW });
    expect(await markRewardExpiryNoticeFailed(db, c, "alimtalk_and_sms_failed")).toBe(true);
    [c] = await claimRewardExpiryNotices(db, { now: ms(NOW, 1000) });
    expect(c.attempts).toBe(2);
    expect(await markRewardExpiryNoticeFailed(db, c, "x")).toBe(true);
    [c] = await claimRewardExpiryNotices(db, { now: ms(NOW, 2000) });
    expect(c.attempts).toBe(3);
    expect(await markRewardExpiryNoticeFailed(db, c, "x")).toBe(true);
    expect(await claimRewardExpiryNotices(db, { now: ms(NOW, 3000) })).toEqual([]);
    // 새로 적립하면 지금 소멸 예정은 없어지고, 3년 뒤 기준으로 다시 안내 대상이 된다
    await m.ledger("EARN", 10, ms(NOW, 4000));
    expect(await claimRewardExpiryNotices(db, { now: ms(NOW, 5000) })).toEqual([]);
    const later = ms(ms(NOW, 4000), 3 * 365 * DAY - 10 * DAY);
    expect((await claimRewardExpiryNotices(db, { now: later })).map((x) => x.buyerMemberId)).toEqual([m.buyer.id]);
  });

  it("옛 시도 번호로는 결과를 남기지 못한다(멈췄다 돌아온 작업자가 새 시도를 덮어쓰지 않음)", async () => {
    const m = await member(500);
    await m.ledger("EARN", 500, earnedLeft(20));
    const [first] = await claimRewardExpiryNotices(db, { now: NOW });
    const [second] = await claimRewardExpiryNotices(db, { now: ms(NOW, 11 * 60_000) });
    expect(second.attempts).toBe(2);
    expect(await markRewardExpiryNoticeSent(db, first)).toBe(false);
    expect(await markRewardExpiryNoticeSent(db, second)).toBe(true);
  });
});
