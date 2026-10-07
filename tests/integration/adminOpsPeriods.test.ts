import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrderStatus, RewardLedgerStatus, RewardLedgerType } from "@prisma/client";
import { GET as activityGet } from "../../app/api/admin/ops/seller-activity/route";
import { GET as payoutGet } from "../../app/api/admin/ops/live-payout-sellers/route";
import { listSellerActivity, listLivePayoutSellers } from "../../lib/server/admin/ops";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import * as clock from "../../lib/server/billing/subscription";
import { prisma } from "../../lib/server/db";
import { createAdmin, createBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });
const at = new Date("2026-10-06T15:10:00Z"); // 10/7 00:10 KST
const todayStart = new Date("2026-10-06T15:00:00Z");
const sevenStart = new Date("2026-09-30T15:00:00Z");
const thirtyStart = new Date("2026-09-07T15:00:00Z");
const manualStart = new Date(at.getTime() - 30 * 86_400_000);
let seq = 0;
async function shop() {
  const s = await createSeller();
  return { ...s, buyer: await createBuyer(s.seller.id, s.grade.id) };
}
async function admin(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role), s = await createAdminSession(db, a.id, {});
  const ctx = await resolveAdminSession(db, s.token);
  if (!ctx) throw new Error("missing admin");
  return { ctx, cookie: `lo_admin=${s.token}` };
}
const justBefore = (d: Date) => new Date(d.getTime() - 1);
function order(s: Awaited<ReturnType<typeof shop>>, createdAt: Date, paidAt: Date | null, refundAmount = 0, status: OrderStatus = paidAt ? "PAID" : "PENDING_PAYMENT") {
  return db.order.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderNo: ++seq,
    broadcastNicknameSnapshot: "PRIVATE-NICKNAME", totalAmount: 10000, createdAt, paidAt, refundAmount, status } });
}
function ledger(s: Awaited<ReturnType<typeof shop>>, type: RewardLedgerType, amount: number, status: RewardLedgerStatus, processedAt: Date | null, testMode = false, failureReason: string | null = null) {
  return db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, idempotencyKey: `read-${++seq}`,
    type, amount, status, processedAt, testMode, failureReason } });
}

it("MA042 KST 오늘 포함 7/30일과 생성/결제 시각·현재 환불 차감 및 오늘 호환 필드를 구분한다", async () => {
  const s = await shop(), v = await admin();
  await order(s, justBefore(sevenStart), todayStart);
  await order(s, sevenStart, justBefore(at), 2000);
  await order(s, justBefore(at), null);
  await order(s, at, at);
  await order(s, thirtyStart, thirtyStart, 10000, "REFUNDED");
  await order(s, justBefore(thirtyStart), justBefore(thirtyStart));
  const old = await order(s, justBefore(at), null, 0, "CANCELLED");
  vi.spyOn(clock, "dbNow").mockResolvedValue(at);
  const snapshot = await db.order.findMany({ orderBy: { id: "asc" } });
  const day = await listSellerActivity(db, v.ctx, {});
  const week = await listSellerActivity(db, v.ctx, { period: "7d" });
  const month = await listSellerActivity(db, v.ctx, { period: "30d" });
  if (!day.ok || !week.ok || !month.ok) throw new Error("period");
  expect(day.items[0].ordersPeriod).toEqual({ created: 2, paid: 2, paidAmount: 18000 });
  expect(week.period).toMatchObject({ days: 7, from: "2026-10-01", to: "2026-10-07", start: sevenStart, end: at });
  expect(week.items[0].ordersPeriod).toEqual({ created: 3, paid: 2, paidAmount: 18000 });
  expect(month.period.start).toEqual(thirtyStart);
  expect(month.items[0].ordersPeriod).toEqual({ created: 5, paid: 3, paidAmount: 18000 });
  expect(week.items[0].ordersToday).toEqual(day.items[0].ordersToday);
  expect(month.items[0].ordersToday).toEqual(day.items[0].ordersToday);
  expect(week.sources).toMatchObject({ paid: "INTERNAL_ORDER_PAID_AT_CURRENT_REFUND_NET", externalOrders: "NOT_MEASURED" });
  vi.mocked(clock.dbNow).mockResolvedValue(new Date(at.getTime() + 86_400_000));
  const fixed = await listSellerActivity(db, v.ctx, { period: "7d", asOf: at.toISOString() });
  if (!fixed.ok) throw new Error("asOf");
  expect(fixed.period).toEqual(week.period);
  expect(fixed.summary).toEqual(week.summary);
  expect(fixed.observedAt).not.toEqual(fixed.at);
  expect(await db.order.findMany({ orderBy: { id: "asc" } })).toEqual(snapshot);
  expect(JSON.stringify(week)).not.toContain(old.id);
  expect(JSON.stringify(week)).not.toContain("PRIVATE-NICKNAME");
});

it("MA042 전체 합계는 50건 밖과 정지 판매자를 포함하고 승인 대기/다른 기간 주문은 제외한다", async () => {
  const s = await shop(), suspended = await shop(), pending = await shop(), v = await admin();
  await db.seller.update({ where: { id: s.seller.id }, data: { createdAt: new Date("2000-01-01") } });
  await db.seller.update({ where: { id: suspended.seller.id }, data: { status: "SUSPENDED", createdAt: new Date("2000-01-02") } });
  await db.seller.update({ where: { id: pending.seller.id }, data: { status: "PENDING" } });
  await db.seller.createMany({ data: Array.from({ length: 51 }, (_, i) => ({ id: randomUUID(), slug: `period-${i}`, shopName: "기간 시험", status: "ACTIVE" })) });
  await order(s, sevenStart, sevenStart);
  await order(s, justBefore(sevenStart), justBefore(sevenStart));
  await order(suspended, justBefore(at), justBefore(at), 2500);
  await order(pending, justBefore(at), justBefore(at));
  vi.spyOn(clock, "dbNow").mockResolvedValue(at);
  const first = await listSellerActivity(db, v.ctx, { period: "7d" });
  if (!first.ok) throw new Error("first");
  expect(first.items).toHaveLength(50);
  expect(first.items.every((r) => r.ordersPeriod.created === 0)).toBe(true);
  expect(first.summary).toEqual({ scope: "CURRENT_ACTIVE_AND_SUSPENDED_SELLERS", created: 2, paid: 2, paidAmount: 17500 });
  const next = await listSellerActivity(db, v.ctx, { period: "7d", cursor: first.nextCursor });
  if (!next.ok) throw new Error("next");
  expect(next.summary).toEqual(first.summary);
  expect(next.items.find((r) => r.sellerId === suspended.seller.id)?.ordersPeriod.paidAmount).toBe(7500);
});

it("MA043 월 paidAt 분모·25% 경계·양수 실성공 조정과 모의/일시 불확실 실패를 구분하며 잔액/원장을 바꾸지 않는다", async () => {
  const s = await shop(), zero = await shop(), off = await shop(), v = await admin();
  await db.rewardPolicy.create({ data: { sellerId: s.seller.id, livePayoutEnabled: true, rates: { [s.grade.id]: { card: 5, bankTransfer: 2.5 } } } });
  await db.rewardPolicy.create({ data: { sellerId: zero.seller.id, livePayoutEnabled: true, rates: { broken: { card: 11 } } } });
  await db.rewardPolicy.create({ data: { sellerId: off.seller.id, livePayoutEnabled: false } });
  await db.rewardBalance.createMany({ data: [{ sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 2000 }, { sellerId: zero.seller.id, buyerMemberId: zero.buyer.id, balance: 100 }] });
  await order(s, new Date("2026-09-01"), justBefore(at), 2000); // 이전 월 생성·이번 월 결제 = 분모 8000
  await order(s, justBefore(at), new Date("2026-09-01")); // 이번 월 생성·이전 월 결제는 제외
  await order(s, justBefore(at), at); // 끝 경계 제외
  await order(zero, justBefore(at), justBefore(at), 10000, "REFUNDED"); // 전체 환불로 분모 0
  await ledger(s, "EARN", 30, "SUCCEEDED", justBefore(at));
  await ledger(s, "ADJUST", 50, "SUCCEEDED", manualStart);
  await ledger(s, "ADJUST", 40, "SUCCEEDED", justBefore(at));
  await ledger(s, "ADJUST", 90, "SUCCEEDED", justBefore(manualStart));
  await ledger(s, "ADJUST", -30, "SUCCEEDED", justBefore(at));
  await ledger(s, "ADJUST", 100, "SUCCEEDED", justBefore(at), true);
  await ledger(s, "ADJUST", 100, "SUCCEEDED", at); // 끝 경계 제외
  await ledger(s, "EARN", 100, "FAILED", todayStart);
  await ledger(s, "RANKING_BONUS", 100, "FAILED", todayStart, true);
  await ledger(s, "ADJUST", 100, "FAILED", null);
  await ledger(s, "EARN", 100, "FAILED", todayStart, false, "member_withdrawn");
  await ledger(off, "EARN", 100, "FAILED", todayStart);
  await ledger(zero, "EARN", 10, "FAILED", todayStart);
  vi.spyOn(clock, "dbNow").mockResolvedValue(at);
  const before = await db.rewardLedger.findMany({ orderBy: { id: "asc" } });
  const balances = await db.rewardBalance.findMany({ orderBy: { sellerId: "asc" } });
  const result = await listLivePayoutSellers(db, v.ctx);
  expect(result.items).toHaveLength(2);
  expect(result.windows.manual30Days).toMatchObject({ start: manualStart, end: at, kind: "ROLLING_30_DAYS" });
  expect(result.items.find((r) => r.sellerId === s.seller.id)).toMatchObject({ monthTradingAmount: 8000, balanceRatioPercent: 25,
    maxConfiguredRewardRatePercent: 5, manualGrant30DaysAmount: 90,
    payoutToday: { succeeded: 2, failed: null, observedFailed: 2, uncertainModeFailed: 1, undatedFailed: 1 },
    signals: { balanceRatio: { state: "OK" }, payoutFailure: { state: "UNKNOWN" }, manualConcentration: { state: "NOT_DEFINED" } } });
  expect(result.items.find((r) => r.sellerId === zero.seller.id)).toMatchObject({ monthTradingAmount: 0, balanceRatioPercent: null, maxConfiguredRewardRatePercent: null,
    payoutToday: { failed: 1, observedFailed: 1, uncertainModeFailed: 0, undatedFailed: 0 }, signals: { balanceRatio: { state: "UNAVAILABLE" } } });
  expect(await db.rewardLedger.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  expect(await db.rewardBalance.findMany({ orderBy: { sellerId: "asc" } })).toEqual(balances);
  await db.rewardBalance.update({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } }, data: { balance: 2010 } });
  expect((await listLivePayoutSellers(db, v.ctx)).items.find((r) => r.sellerId === s.seller.id)?.signals.balanceRatio.state).toBe("WARN");
  expect(JSON.stringify(result)).not.toContain(s.buyer.id);
  expect(JSON.stringify(result)).not.toContain("failureReason");
});

it("MA042/043 원천이 비었을 때와 모든 관리자/401/잘못된 기간·커서의 no-store를 유지한다", async () => {
  vi.spyOn(clock, "dbNow").mockResolvedValue(at);
  for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
    const v = await admin(role);
    for (const route of [activityGet, payoutGet]) {
      const response = await route(new Request("http://localhost:3000/x?period=30d", { headers: { cookie: v.cookie } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ items: [] });
    }
  }
  const v = await admin();
  for (const query of ["period=week", "period=", "cursor=bad", "asOf=bad", "asOf=", `asOf=${new Date(at.getTime() + 1).toISOString()}`]) {
    const response = await activityGet(new Request(`http://localhost:3000/x?${query}`, { headers: { cookie: v.cookie } }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  for (const route of [activityGet, payoutGet]) {
    const response = await route(new Request("http://localhost:3000/x"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
});
