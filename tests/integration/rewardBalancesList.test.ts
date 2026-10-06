import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listRewardBalances } from "../../lib/server/seller-settings/rewardBalances";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-033 회원별 잔액 목록 확장: 등급·검색 필드·조건(잔액 있음·소멸 예정·지급 대기)·정렬 3종·소멸 예정(마지막 적립 + 3년)·합계·지급 대기 안내·커서.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

let n = 0;
async function setup() {
  const { seller, grade } = await createSeller();
  const gold = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "골드", sortOrder: 1, minAmount: 500000 } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, gold, ctx };
}
type S = Awaited<ReturnType<typeof setup>>;
async function member(s: S, d: { nick: string; name?: string; grade?: "basic" | "gold"; balance?: number | null; updatedAt?: string }) {
  const m = await createBuyer(s.seller.id, d.grade === "gold" ? s.gold.id : s.grade.id);
  await db.buyerMember.update({ where: { id: m.id }, data: { broadcastNickname: d.nick, name: d.name ?? `이름${n++}` } });
  if (d.balance !== null && d.balance !== undefined) await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, balance: d.balance, updatedAt: new Date(d.updatedAt ?? "2026-10-01T00:00:00Z") } });
  return m;
}
const ledger = (s: S, memberId: string, d: { type?: "EARN" | "ADJUST" | "RANKING_BONUS"; amount?: number; status?: "PENDING" | "SUCCEEDED"; at: string; testMode?: boolean }) =>
  db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: memberId, type: d.type ?? "EARN", amount: d.amount ?? 100, status: d.status ?? "SUCCEEDED", testMode: d.testMode ?? false, idempotencyKey: `k${n++}`, createdAt: new Date(d.at) } });
const nicks = async (s: S, q: Parameters<typeof listRewardBalances>[2] = {}) => {
  const r = await listRewardBalances(db, s.ctx, q);
  if (!r.ok) throw new Error("list");
  return r.balances.map((b) => b.member.broadcastNickname);
};
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const threeYearsAgoPlus = (days: number) => {
  const t = new Date(Date.now() + days * 86_400_000);
  t.setUTCFullYear(t.getUTCFullYear() - 3);
  return t.toISOString();
};

describe("회원별 잔액 목록 (SA-033)", () => {
  it("등급·검색 필드(닉네임·이름)·합계: 조건에 맞는 전체의 회원 수와 합계 잔액, 다른 쇼핑몰·탈퇴 회원 제외", async () => {
    const s = await setup();
    await member(s, { nick: "별빛사냥꾼", name: "김하나", grade: "gold", balance: 32400 });
    await member(s, { nick: "카드왕", name: "이둘", grade: "gold", balance: 17000 });
    await member(s, { nick: "새벽별", name: "박셋", balance: 4100 });
    const gone = await member(s, { nick: "탈퇴자", balance: 999 });
    await db.buyerMember.update({ where: { id: gone.id }, data: { deletedAt: new Date(), status: "WITHDRAWN" } });
    const o = await setup();
    await member(o, { nick: "남의별빛", balance: 77777 });
    const all = await listRewardBalances(db, s.ctx, {});
    expect(all.ok && all.summary).toEqual({ count: 3, totalBalance: 53500 });
    const gold = await listRewardBalances(db, s.ctx, { gradeId: s.gold.id });
    expect(gold.ok && gold.summary).toEqual({ count: 2, totalBalance: 49400 });
    expect(gold.ok && gold.balances.every((b) => b.grade.name === "골드")).toBe(true);
    expect(await nicks(s, { q: "별", sort: "balance" })).toEqual(["별빛사냥꾼", "새벽별"]);
    expect(await nicks(s, { q: "이둘", field: "name" })).toEqual(["카드왕"]);
    expect(await nicks(s, { q: "이둘", field: "nickname" })).toEqual([]);
    expect(await nicks(s, { q: "50%_" })).toEqual([]); // LIKE 기호는 글자 그대로
    const q = await listRewardBalances(db, s.ctx, { q: "별빛" });
    expect(q.ok && q.summary).toEqual({ count: 1, totalBalance: 32400 });
  });

  it("정렬: 잔액 많은 순·최근 변동순(기본)·소멸 예정 가까운 순(소멸 예정이 없는 회원은 뒤)", async () => {
    const s = await setup();
    const a = await member(s, { nick: "A", balance: 100, updatedAt: "2026-10-03T00:00:00Z" });
    const b = await member(s, { nick: "B", balance: 900, updatedAt: "2026-10-01T00:00:00Z" });
    const c = await member(s, { nick: "C", balance: 500, updatedAt: "2026-10-02T00:00:00Z" });
    await member(s, { nick: "D", balance: 0, updatedAt: "2026-10-04T00:00:00Z" });
    await ledger(s, a.id, { at: threeYearsAgoPlus(20) }); // A: 20일 뒤 소멸
    await ledger(s, b.id, { at: threeYearsAgoPlus(10) }); // B: 10일 뒤 소멸
    await ledger(s, c.id, { at: threeYearsAgoPlus(400) }); // C: 400일 뒤
    expect(await nicks(s)).toEqual(["D", "A", "C", "B"]);
    expect(await nicks(s, { sort: "recent" })).toEqual(["D", "A", "C", "B"]);
    expect(await nicks(s, { sort: "balance" })).toEqual(["B", "C", "A", "D"]);
    expect(await nicks(s, { sort: "expiring" })).toEqual(["B", "A", "C", "D"]);
  });

  it("소멸 예정: 잔액 + 마지막 적립 + 3년, 30일 안이면 soon·「소멸 예정 있음」 조건. 시험 모드·실패·음수 적립은 마지막 적립으로 안 센다", async () => {
    const s = await setup();
    const soon = await member(s, { nick: "곧", balance: 2000 });
    const later = await member(s, { nick: "나중", balance: 800 });
    const noEarn = await member(s, { nick: "적립없음", balance: 300 });
    const test = await member(s, { nick: "시험만", balance: 100 });
    await ledger(s, soon.id, { at: threeYearsAgoPlus(15), type: "ADJUST", amount: 50 });
    await ledger(s, soon.id, { at: threeYearsAgoPlus(-500) }); // 더 오래된 적립은 무관(가장 늦은 것이 기준)
    await ledger(s, later.id, { at: threeYearsAgoPlus(200) });
    await ledger(s, test.id, { at: threeYearsAgoPlus(5), testMode: true });
    const r = await listRewardBalances(db, s.ctx, { sort: "expiring" });
    if (!r.ok) throw new Error("list");
    const by = new Map(r.balances.map((b) => [b.member.broadcastNickname, b]));
    expect(by.get("곧")?.expiry).toMatchObject({ amount: 2000, soon: true });
    const days = (by.get("곧")!.expiry!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(14);
    expect(days).toBeLessThan(16);
    expect(by.get("나중")?.expiry).toMatchObject({ amount: 800, soon: false });
    expect(by.get("적립없음")?.expiry).toBeNull();
    expect(by.get("시험만")?.expiry).toBeNull();
    expect(await nicks(s, { condition: "expiring" })).toEqual(["곧"]);
    expect(noEarn.id).toBeTruthy();
  });

  it("지급 대기 있음·잔액 있음 조건: 대기 줄만 있고 잔액 행이 없는 회원도 목록에 나오고, 지급 대기 안내 값을 준다", async () => {
    const s = await setup();
    const withBal = await member(s, { nick: "잔액", balance: 500 });
    const pendingOnly = await member(s, { nick: "대기만", balance: null });
    const zero = await member(s, { nick: "영", balance: 0 });
    await ledger(s, pendingOnly.id, { amount: 1200, status: "PENDING", at: "2026-10-01T00:00:00Z", testMode: true });
    await ledger(s, withBal.id, { amount: 300, status: "PENDING", at: "2026-10-01T00:00:00Z", testMode: true });
    await ledger(s, withBal.id, { amount: 50, status: "PENDING", at: "2026-10-01T00:00:00Z", testMode: true });
    expect((await nicks(s)).sort()).toEqual(["대기만", "영", "잔액"]);
    expect(await nicks(s, { condition: "hasBalance" })).toEqual(["잔액"]);
    expect((await nicks(s, { condition: "pending" })).sort()).toEqual(["대기만", "잔액"]);
    const r = await listRewardBalances(db, s.ctx, { condition: "pending" });
    if (!r.ok) throw new Error("list");
    expect(r.pending).toEqual({ count: 3, amount: 1550 });
    expect(r.balances.find((b) => b.member.broadcastNickname === "대기만")).toMatchObject({ balance: 0, pendingCount: 1, updatedAt: null });
    expect(r.balances.find((b) => b.member.broadcastNickname === "잔액")?.pendingCount).toBe(2);
    expect(r.summary).toEqual({ count: 2, totalBalance: 500 });
    expect(zero.id).toBeTruthy();
    // 잔액 없고 대기 없으면 합계·대기 안내 모두 0
    const o = await setup();
    const empty = await listRewardBalances(db, o.ctx, {});
    expect(empty.ok && [empty.summary, empty.pending, empty.balances]).toEqual([{ count: 0, totalBalance: 0 }, { count: 0, amount: 0 }, []]);
  });

  it("커서: 정렬이 같은 값(잔액 동률)이어도 빠짐·겹침 없이 쪽을 넘기고, 잘못된 값은 거부", async () => {
    const s = await setup();
    for (let i = 0; i < 7; i++) await member(s, { nick: `M${i}`, balance: i % 2 ? 100 : 200, updatedAt: "2026-10-01T00:00:00Z" });
    for (const sort of ["recent", "balance", "expiring"] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const r = await listRewardBalances(db, s.ctx, { sort, limit: "3", cursor });
        if (!r.ok) throw new Error("page");
        seen.push(...r.balances.map((b) => b.member.broadcastNickname));
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      expect(seen, sort).toHaveLength(7);
      expect(new Set(seen).size, sort).toBe(7);
    }
    for (const bad of [{ sort: "x" }, { condition: "x" }, { field: "phone" }, { gradeId: "nope" }, { cursor: "abc" }, { limit: "0" }, { q: "x".repeat(51) }]) {
      expect(await listRewardBalances(db, s.ctx, bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });

  it("다른 쇼핑몰 등급 id로 거르면 아무도 안 나오고, 권한 없는 직원은 403", async () => {
    const s = await setup();
    const o = await setup();
    await member(s, { nick: "내회원", balance: 10 });
    expect(await nicks(s, { gradeId: o.grade.id })).toEqual([]);
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    await expect(listRewardBalances(db, staff, {})).rejects.toMatchObject({ status: 403 });
  });
});
