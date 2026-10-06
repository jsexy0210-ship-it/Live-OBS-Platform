import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listRewardLedger, rewardLedgerSummary } from "../../lib/server/seller-settings/rewardLedger";
import { orderNoLabel } from "../../lib/server/orders/orderNoLabel";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-032 확장: 유형(kind) 필터, 닉네임·주문번호 검색, 「잔액(후)」, 주문 요약, 사유, 요약 카드. 판매자 격리·권한.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

let n = 0;
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const member = await createBuyer(seller.id, grade.id);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, member, ctx };
}
type S = Awaited<ReturnType<typeof setup>>;
async function row(s: S, d: { type?: "EARN" | "REVOKE" | "ADJUST" | "RANKING_BONUS" | "USE" | "EXPIRE"; amount: number; status?: "PENDING" | "SUCCEEDED" | "FAILED"; at: string; key?: string; orderId?: string; reason?: string; failureReason?: string; memberId?: string }) {
  const at = new Date(d.at);
  return db.rewardLedger.create({
    data: {
      sellerId: s.seller.id,
      buyerMemberId: d.memberId ?? s.member.id,
      orderId: d.orderId ?? null,
      type: d.type ?? "EARN",
      amount: d.amount,
      status: d.status ?? "SUCCEEDED",
      testMode: false,
      reason: d.reason ?? null,
      failureReason: d.failureReason ?? null,
      idempotencyKey: d.key ?? `k${n++}`,
      createdAt: at,
      processedAt: (d.status ?? "SUCCEEDED") === "PENDING" ? null : at,
    },
  });
}

describe("원장 확장 (SA-032)", () => {
  it("잔액(후)는 성공 줄을 처리 시각 순으로 더한 값이고, 대기·실패 줄과 다른 회원·다른 쇼핑몰은 섞이지 않는다", async () => {
    const s = await setup();
    const other = await createBuyer(s.seller.id, s.grade.id);
    const e1 = await row(s, { amount: 1000, at: "2026-10-01T01:00:00Z" });
    const e2 = await row(s, { type: "REVOKE", amount: -300, at: "2026-10-01T02:00:00Z" });
    const pend = await row(s, { amount: 5000, status: "PENDING", at: "2026-10-01T03:00:00Z" });
    const fail = await row(s, { type: "REVOKE", amount: -9999, status: "FAILED", at: "2026-10-01T04:00:00Z", failureReason: "insufficient" });
    const e3 = await row(s, { type: "ADJUST", amount: 500, at: "2026-10-01T05:00:00Z", reason: "이벤트 보상" });
    await row(s, { amount: 77, at: "2026-10-01T00:30:00Z", memberId: other.id });
    const o = await setup();
    await row(o, { amount: 123456, at: "2026-10-01T00:00:00Z" });
    const r = await listRewardLedger(db, s.ctx, {});
    if (!r.ok) throw new Error("list");
    const by = new Map(r.entries.map((e) => [e.id, e]));
    expect(by.get(e1.id)?.balanceAfter).toBe(1000);
    expect(by.get(e2.id)?.balanceAfter).toBe(700);
    expect(by.get(e3.id)?.balanceAfter).toBe(1200);
    expect(by.get(pend.id)?.balanceAfter).toBeNull();
    expect(by.get(fail.id)?.balanceAfter).toBeNull();
    expect(by.get(e3.id)).toMatchObject({ kind: "ADJUST_GRANT", reason: "이벤트 보상" });
    // 페이지가 나뉘어도 같은 값(앞 페이지 줄을 이 페이지가 안 갖고 있어도 누적은 DB에서 센다)
    const p1 = await listRewardLedger(db, s.ctx, { limit: "2" });
    if (!p1.ok || !p1.nextCursor) throw new Error("page");
    const p2 = await listRewardLedger(db, s.ctx, { limit: "2", cursor: p1.nextCursor });
    if (!p2.ok) throw new Error("page2");
    const merged = new Map([...p1.entries, ...p2.entries].map((e) => [e.id, e.balanceAfter]));
    expect(merged.get(e2.id)).toBe(700);
  });

  it("유형(kind) 분류와 필터: 배송 완료·결제 적립은 주문의 지급 시점 스냅숏, 리뷰·회수·수동 지급/회수·보너스", async () => {
    const s = await setup();
    const a = await createPaidOrderItem(s.seller.id, s.member.id);
    const b = await createPaidOrderItem(s.seller.id, s.member.id);
    await db.order.update({ where: { id: a.order.id }, data: { rewardEarnTiming: "ON_DELIVERY" } });
    await db.order.update({ where: { id: b.order.id }, data: { rewardEarnTiming: "ON_PAYMENT" } });
    const kinds: Record<string, string> = {};
    kinds.EARN_DELIVERY = (await row(s, { amount: 100, at: "2026-10-01T01:00:00Z", orderId: a.order.id, key: `earn:${a.order.id}` })).id;
    kinds.EARN_PAYMENT = (await row(s, { amount: 100, at: "2026-10-01T02:00:00Z", orderId: b.order.id, key: `earn:${b.order.id}` })).id;
    kinds.REVIEW = (await row(s, { amount: 500, at: "2026-10-01T03:00:00Z", orderId: a.order.id, key: "review_reward:r1:1" })).id;
    kinds.REVOKE = (await row(s, { type: "REVOKE", amount: -50, at: "2026-10-01T04:00:00Z" })).id;
    kinds.ADJUST_GRANT = (await row(s, { type: "ADJUST", amount: 10, at: "2026-10-01T05:00:00Z", reason: "a" })).id;
    kinds.ADJUST_REVOKE = (await row(s, { type: "ADJUST", amount: -10, at: "2026-10-01T06:00:00Z", reason: "b" })).id;
    kinds.BONUS = (await row(s, { type: "RANKING_BONUS", amount: 5000, at: "2026-10-01T07:00:00Z" })).id;
    kinds.USE = (await row(s, { type: "USE", amount: -1000, at: "2026-10-01T08:00:00Z" })).id;
    kinds.EXPIRE = (await row(s, { type: "EXPIRE", amount: -100, at: "2026-10-01T09:00:00Z" })).id;
    const all = await listRewardLedger(db, s.ctx, {});
    if (!all.ok) throw new Error("list");
    for (const [kind, id] of Object.entries(kinds)) {
      expect(all.entries.find((e) => e.id === id)?.kind, kind).toBe(kind);
      const one = await listRewardLedger(db, s.ctx, { kind });
      expect(one.ok && one.entries.map((e) => e.id), `filter ${kind}`).toEqual([id]);
    }
    expect(await listRewardLedger(db, s.ctx, { kind: "NOPE" })).toEqual({ ok: false });
  });

  it("검색: 닉네임 부분 일치, 주문번호(라벨·순번), 다른 쇼핑몰 줄은 안 나옴. 주문 요약(첫 상품·품목 수)", async () => {
    const s = await setup();
    const member2 = await createBuyer(s.seller.id, s.grade.id);
    await db.buyerMember.update({ where: { id: member2.id }, data: { broadcastNickname: "별빛사냥꾼" } });
    const { order } = await createPaidOrderItem(s.seller.id, s.member.id);
    const e1 = await row(s, { amount: 100, at: "2026-10-01T01:00:00Z", orderId: order.id });
    const e2 = await row(s, { amount: 200, at: "2026-10-01T02:00:00Z", memberId: member2.id });
    const q = async (v: string) => {
      const r = await listRewardLedger(db, s.ctx, { q: v });
      return r.ok ? r.entries.map((e) => e.id) : null;
    };
    expect(await q("별빛")).toEqual([e2.id]);
    expect(await q(orderNoLabel(order.createdAt, order.orderNo))).toEqual([e1.id]);
    expect(await q(String(order.orderNo))).toEqual([e1.id]);
    expect(await q("없는닉네임")).toEqual([]);
    expect(await q("x".repeat(51))).toBeNull();
    const r = await listRewardLedger(db, s.ctx, {});
    if (!r.ok) throw new Error("list");
    expect(r.entries.find((e) => e.id === e1.id)?.order).toMatchObject({ orderNo: order.orderNo, itemCount: 1 });
    expect(r.entries.find((e) => e.id === e1.id)?.order?.firstProductName).toBeTruthy();
    expect(r.entries.find((e) => e.id === e2.id)?.order).toBeNull();
    // 다른 쇼핑몰이 같은 닉네임·주문번호를 가져도 섞이지 않는다
    const o = await setup();
    await db.buyerMember.update({ where: { id: o.member.id }, data: { broadcastNickname: "별빛사냥꾼2" } });
    await row(o, { amount: 1, at: "2026-10-01T00:00:00Z" });
    expect(await q("별빛")).toEqual([e2.id]);
  });

  it("요약 카드: 대기·오늘 성공·실패(탈퇴 제외)·오늘 회수·총 발행 잔액, 다른 쇼핑몰·탈퇴 회원 제외", async () => {
    const s = await setup();
    const now = new Date("2026-10-02T06:00:00Z"); // KST 15:00
    await row(s, { amount: 1000, status: "PENDING", at: "2026-10-02T05:00:00Z" });
    await row(s, { amount: 500, status: "PENDING", at: "2026-10-02T05:10:00Z" });
    await row(s, { type: "REVOKE", amount: -100, status: "PENDING", at: "2026-10-02T05:20:00Z" });
    await row(s, { amount: 300, at: "2026-10-02T01:00:00Z" }); // 오늘(KST 10시) 성공
    await row(s, { amount: 700, at: "2026-10-01T10:00:00Z" }); // 어제(KST 19시)
    await row(s, { type: "REVOKE", amount: -120, at: "2026-10-02T02:00:00Z" });
    await row(s, { type: "REVOKE", amount: -80, at: "2026-10-01T02:00:00Z" });
    await row(s, { type: "REVOKE", amount: -50, status: "FAILED", at: "2026-10-02T03:00:00Z", failureReason: "insufficient_balance" });
    await row(s, { amount: 999, status: "FAILED", at: "2026-10-02T03:30:00Z", failureReason: "member_withdrawn" });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.member.id, balance: 2000 } });
    const gone = await createBuyer(s.seller.id, s.grade.id);
    await db.buyerMember.update({ where: { id: gone.id }, data: { deletedAt: new Date(), status: "WITHDRAWN" } });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: gone.id, balance: 5000 } });
    const o = await setup();
    await row(o, { amount: 111, status: "PENDING", at: "2026-10-02T05:00:00Z" });
    await db.rewardBalance.create({ data: { sellerId: o.seller.id, buyerMemberId: o.member.id, balance: 9999 } });

    expect(await rewardLedgerSummary(db, s.ctx, now)).toEqual({
      pending: { count: 3, amount: 1500 },
      todaySucceeded: { count: 1, amount: 300 },
      failed: { count: 1, amount: 50 },
      todayRevoked: { count: 1, amount: 120 },
      issuedBalance: 2000,
    });
  });

  it("권한 없는 직원은 조회할 수 없다", async () => {
    const s = await setup();
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    await expect(rewardLedgerSummary(db, staff)).rejects.toMatchObject({ status: 403 });
    await expect(listRewardLedger(db, staff, {})).rejects.toMatchObject({ status: 403 });
  });
});
