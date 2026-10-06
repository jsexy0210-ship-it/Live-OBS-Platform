import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { earnQuote } from "../../lib/server/rewards/earn";
import { updateEarnTiming } from "../../lib/server/rewards/policy";
import { listRewardPolicyHistory, previewRewardPolicy, readRewardPolicy, updateRewardPolicy } from "../../lib/server/rewards/policyAdmin";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function setup() {
  const { seller, grade } = await createSeller();
  const gold = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "골드", sortOrder: 1, minAmount: 500000 } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, basic: grade, gold, owner, ctx };
}
const ratesOf = async (sellerId: string) => (await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId } })).rates;

describe("적립 정책 저장 (SA-031)", () => {
  it("정책이 없으면 초기 상태로 읽고, 저장하면 등급별 적립률·회수 방식·보너스가 반영되며 이력에 항목별로 남는다", async () => {
    const s = await setup();
    const before = await readRewardPolicy(db, s.ctx);
    expect(before).toMatchObject({ configured: false, earnTiming: "ON_DELIVERY", revokeMode: "AUTO", rankingBonus: { enabled: false, amount: 0 }, livePayoutEnabled: false });
    expect(before.grades.map((g) => [g.name, g.card, g.bankTransfer])).toEqual([["일반", null, null], ["골드", null, null]]);

    const r = await updateRewardPolicy(db, s.ctx, { rates: { [s.gold.id]: { card: 1.5, bankTransfer: 2 } }, earnTiming: "ON_PAYMENT", revokeMode: "MANUAL", rankingBonus: { enabled: true, amount: 5000 } });
    expect(r).toMatchObject({ ok: true, changed: true, policy: { configured: true, earnTiming: "ON_PAYMENT", revokeMode: "MANUAL", rankingBonus: { enabled: true, amount: 5000 } } });
    expect(await ratesOf(s.seller.id)).toEqual({ [s.gold.id]: { card: 1.5, bankTransfer: 2 } });

    const h = await listRewardPolicyHistory(db, s.ctx, {});
    expect(h.ok && h.history).toHaveLength(1);
    if (h.ok) {
      expect(h.history[0].actorName).toBe("직원");
      expect(h.history[0].changes).toEqual(
        expect.arrayContaining([
          { kind: "rate", gradeId: s.gold.id, gradeName: "골드", method: "card", before: null, after: 1.5 },
          { kind: "rate", gradeId: s.gold.id, gradeName: "골드", method: "bankTransfer", before: null, after: 2 },
          { kind: "earnTiming", before: "ON_DELIVERY", after: "ON_PAYMENT" },
          { kind: "revokeMode", before: "AUTO", after: "MANUAL" },
          { kind: "rankingBonus", before: { enabled: false, amount: 0 }, after: { enabled: true, amount: 5000 } },
        ]),
      );
      expect(h.history[0].changes).toHaveLength(5);
    }
  });

  it("저장한 적립률로 실제 지급액이 계산된다(원 단위 내림)", async () => {
    const s = await setup();
    await updateRewardPolicy(db, s.ctx, { rates: { [s.basic.id]: { card: 1.5 } } });
    const p = await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    expect(earnQuote({ rates: p.rates, earnStartsAt: p.earnStartsAt, gradeId: s.basic.id, paymentMethod: "CARD", base: 189000, now: new Date() })).toEqual({ rate: 1.5, amount: 2835 });
    expect(earnQuote({ rates: p.rates, earnStartsAt: p.earnStartsAt, gradeId: s.basic.id, paymentMethod: "BANK_TRANSFER", base: 189000, now: new Date() }).amount).toBe(0);
  });

  it("경계값: 0과 10%는 되고, 10.1·−0.1·소수 둘째 자리·문자열·모르는 항목은 거부(아무것도 바뀌지 않음)", async () => {
    const s = await setup();
    const ok = await updateRewardPolicy(db, s.ctx, { rates: { [s.basic.id]: { card: 0, bankTransfer: 10 } } });
    expect(ok).toMatchObject({ ok: true });
    const snapshot = await ratesOf(s.seller.id);
    const bad = (rates: unknown) => updateRewardPolicy(db, s.ctx, { rates });
    expect(await bad({ [s.basic.id]: { card: 10.1 } })).toEqual({ ok: false, reason: "reward_rate_out_of_range" });
    expect(await bad({ [s.basic.id]: { card: -0.1 } })).toEqual({ ok: false, reason: "reward_rate_out_of_range" });
    expect(await bad({ [s.basic.id]: { card: 1.25 } })).toEqual({ ok: false, reason: "reward_rate_unit" });
    expect(await bad({ [s.basic.id]: { card: "1" } })).toEqual({ ok: false, reason: "invalid_reward_policy" });
    expect(await bad({ [s.basic.id]: { other: 1 } })).toEqual({ ok: false, reason: "invalid_reward_policy" });
    expect(await bad({ "not-uuid": { card: 1 } })).toEqual({ ok: false, reason: "invalid_reward_policy" });
    expect(await updateRewardPolicy(db, s.ctx, {})).toEqual({ ok: false, reason: "invalid_reward_policy" });
    expect(await updateRewardPolicy(db, s.ctx, { unknown: 1 })).toEqual({ ok: false, reason: "invalid_reward_policy" });
    expect(await updateRewardPolicy(db, s.ctx, { revokeMode: "NEGATIVE" })).toEqual({ ok: false, reason: "invalid_reward_policy" });
    expect(await updateRewardPolicy(db, s.ctx, { rankingBonus: { enabled: true, amount: 0 } })).toEqual({ ok: false, reason: "reward_ranking_bonus_invalid" });
    expect(await updateRewardPolicy(db, s.ctx, { rankingBonus: { enabled: false, amount: 1.5 } })).toEqual({ ok: false, reason: "reward_ranking_bonus_invalid" });
    expect(await ratesOf(s.seller.id)).toEqual(snapshot);
    expect(await db.auditLog.count({ where: { action: "reward_policy.update" } })).toBe(1);
  });

  it("부분 저장은 다른 등급·다른 항목을 건드리지 않고, null은 비우고, 바뀐 게 없으면 이력을 남기지 않는다", async () => {
    const s = await setup();
    await updateRewardPolicy(db, s.ctx, { rates: { [s.basic.id]: { card: 1, bankTransfer: 1.5 }, [s.gold.id]: { card: 2 } } });
    await updateRewardPolicy(db, s.ctx, { rates: { [s.gold.id]: { card: 2.5, bankTransfer: null } } });
    expect(await ratesOf(s.seller.id)).toEqual({ [s.basic.id]: { card: 1, bankTransfer: 1.5 }, [s.gold.id]: { card: 2.5 } });
    const same = await updateRewardPolicy(db, s.ctx, { rates: { [s.gold.id]: { card: 2.5 } } });
    expect(same).toMatchObject({ ok: true, changed: false });
    await updateRewardPolicy(db, s.ctx, { rates: { [s.gold.id]: { card: null } } });
    expect(await ratesOf(s.seller.id)).toEqual({ [s.basic.id]: { card: 1, bankTransfer: 1.5 } });
    expect(await db.auditLog.count({ where: { action: "reward_policy.update" } })).toBe(3);
  });

  it("동시에 서로 다른 등급을 저장해도 한쪽이 덮이지 않는다", async () => {
    const s = await setup();
    await Promise.all([updateRewardPolicy(db, s.ctx, { rates: { [s.basic.id]: { card: 1 } } }), updateRewardPolicy(db, s.ctx, { rates: { [s.gold.id]: { card: 2 } } }), updateRewardPolicy(db, s.ctx, { revokeMode: "MANUAL" })]);
    expect(await ratesOf(s.seller.id)).toEqual({ [s.basic.id]: { card: 1 }, [s.gold.id]: { card: 2 } });
    expect((await db.rewardPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).revokeMode).toBe("MANUAL");
  });

  it("다른 쇼핑몰 등급은 쓸 수 없고, 정책·이력은 쇼핑몰별로 갈린다", async () => {
    const a = await setup();
    const b = await setup();
    expect(await updateRewardPolicy(db, a.ctx, { rates: { [b.basic.id]: { card: 1 } } })).toEqual({ ok: false, reason: "reward_grade_not_found" });
    await updateRewardPolicy(db, b.ctx, { rates: { [b.basic.id]: { card: 3 } } });
    expect(await ratesOf(b.seller.id)).toEqual({ [b.basic.id]: { card: 3 } });
    expect(await db.rewardPolicy.findUnique({ where: { sellerId: a.seller.id } })).toBeNull();
    const h = await listRewardPolicyHistory(db, a.ctx, {});
    expect(h.ok && h.history).toEqual([]);
  });

  it("권한 없는 직원은 저장할 수 없고 조회는 MEMBER_POINTS가 필요하다", async () => {
    const s = await setup();
    const none = await createSellerUser(s.seller.id, { permissions: [] });
    const staff: TenantContext = { ...s.ctx, actorId: none.id, isOwner: false, permissions: [] };
    await expect(updateRewardPolicy(db, staff, { revokeMode: "MANUAL" })).rejects.toMatchObject({ status: 403 });
    await expect(readRewardPolicy(db, staff)).rejects.toMatchObject({ status: 403 });
    const ok: TenantContext = { ...staff, permissions: ["MEMBER_POINTS"] };
    expect(await updateRewardPolicy(db, ok, { revokeMode: "MANUAL" })).toMatchObject({ ok: true });
  });

  it("미리보기는 저장하지 않고 지금과 바꾼 지급액을 돌려준다", async () => {
    const s = await setup();
    await updateRewardPolicy(db, s.ctx, { rates: { [s.basic.id]: { card: 1 } } });
    const r = await previewRewardPolicy(db, s.ctx, { amount: 189000, paymentMethod: "CARD", gradeId: s.basic.id, rates: { [s.basic.id]: { card: 1.5 } } });
    expect(r).toEqual({ ok: true, current: { rate: 1, amount: 1890 }, next: { rate: 1.5, amount: 2835 } });
    expect(await ratesOf(s.seller.id)).toEqual({ [s.basic.id]: { card: 1 } });
    expect(await previewRewardPolicy(db, s.ctx, { amount: 1, paymentMethod: "CASH", gradeId: s.basic.id })).toMatchObject({ ok: false });
    expect(await previewRewardPolicy(db, s.ctx, { amount: 1, paymentMethod: "CARD", gradeId: "11111111-2222-4333-8444-555555555555" })).toEqual({ ok: false, reason: "reward_grade_not_found" });
  });

  it("이력은 최근 순 커서 페이지이고 예전 지급 시점 기록도 같은 모양으로 보인다", async () => {
    const s = await setup();
    await updateEarnTiming(db, s.ctx, { earnTiming: "ON_PAYMENT" });
    for (let i = 1; i <= 3; i++) await updateRewardPolicy(db, s.ctx, { rates: { [s.basic.id]: { card: i } } });
    const p1 = await listRewardPolicyHistory(db, s.ctx, { limit: "2" });
    expect(p1.ok && p1.history.map((h) => h.changes[0])).toMatchObject([{ after: 3 }, { after: 2 }]);
    if (!p1.ok || !p1.nextCursor) throw new Error("cursor");
    const p2 = await listRewardPolicyHistory(db, s.ctx, { limit: "2", cursor: p1.nextCursor });
    expect(p2.ok && p2.history.map((h) => h.changes[0])).toMatchObject([{ after: 1 }, { kind: "earnTiming", before: "ON_DELIVERY", after: "ON_PAYMENT" }]);
    expect(p2.ok && p2.nextCursor).toBeNull();
    expect(await listRewardPolicyHistory(db, s.ctx, { limit: "0" })).toEqual({ ok: false });
    expect(await listRewardPolicyHistory(db, s.ctx, { cursor: "bad" })).toEqual({ ok: false });
  });
});
