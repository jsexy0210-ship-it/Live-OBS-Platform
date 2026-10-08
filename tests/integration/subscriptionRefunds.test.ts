import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as approveRoute } from "../../app/api/admin/subscription-refunds/[refundId]/approve/route";
import { POST as rejectRoute } from "../../app/api/admin/subscription-refunds/[refundId]/reject/route";
import { GET as getRoute } from "../../app/api/admin/subscription-refunds/[refundId]/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/admin/subscription-refunds/route";
import { createAdminSession } from "../../lib/server/auth/session";
import type { FakeBillingProvider } from "../../lib/server/billing/provider";
import { billingProvider } from "../../lib/server/billing/registry";
import { settlePayment } from "../../lib/server/billing/subscription";
import { prisma } from "../../lib/server/db";
import { createAdmin, createSeller, db, resetDb } from "./helpers";

// 구독 환불 요청·처리(MA-026·027): 권한(보기 전 역할, 요청은 최고관리자·운영, 승인·거절은 최고관리자), 시스템 요청(해지 뒤 확정된 결제),
// 직접 요청 검사, 승인 = 가짜 공급자 취소(멱등), 실패·응답 끊김 뒤 다시 승인, 반려, version 충돌·동시 승인, 로그 추적.
beforeAll(() => {
  process.env.BILLING_PROVIDER = "fake";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const p = (refundId: string) => ({ params: Promise.resolve({ refundId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const pg = () => billingProvider() as FakeBillingProvider;

async function paidPayment(opts: { status?: "PAID" | "PENDING"; canceled?: boolean } = {}) {
  const { seller } = await createSeller();
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  const sub = await db.sellerSubscription.create({
    data: { sellerId: seller.id, planId: plan.id, ...(opts.canceled ? { status: "CANCELED", canceledAt: new Date() } : {}) },
  });
  const start = new Date(Date.now() - 86_400_000);
  const payment = await db.subscriptionPayment.create({
    data: {
      sellerId: seller.id,
      subscriptionId: sub.id,
      amount: 199_000,
      status: opts.status ?? "PAID",
      periodStart: start,
      periodEnd: new Date(start.getTime() + 30 * 86_400_000),
      ...(opts.status === "PENDING" ? {} : { providerPaymentId: `fake-pay-${seller.id}`, paidAt: new Date() }),
      createdAt: new Date(Date.now() - 3_600_000),
    },
  });
  return { seller, sub, payment };
}
const create = async (cookie: string, body: unknown) => json(await createRoute(req("/api/admin/subscription-refunds", cookie, "POST", body)));
const approve = async (cookie: string, id: string, body: unknown) => json(await approveRoute(req(`/api/admin/subscription-refunds/${id}/approve`, cookie, "POST", body), p(id)));
const reject = async (cookie: string, id: string, body: unknown) => json(await rejectRoute(req(`/api/admin/subscription-refunds/${id}/reject`, cookie, "POST", body), p(id)));

describe("시스템 환불 요청", () => {
  it("해지 전에 만든 청구가 해지 뒤에 결제 확정되면 환불 요청(시스템, paid_after_cancel)이 하나 생긴다", async () => {
    const { payment, sub } = await paidPayment({ status: "PENDING" });
    await db.sellerSubscription.update({ where: { id: sub.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    await settlePayment(db, payment.id, { ok: true, paymentId: "fake-pay-late", receiptUrl: null }, { actorType: "SYSTEM", actorId: null });
    expect(await db.subscriptionRefund.findMany({ where: { paymentId: payment.id } })).toEqual([
      expect.objectContaining({ source: "SYSTEM", reason: "paid_after_cancel", status: "REQUESTED", amount: 199_000 }),
    ]);
    // 결제 실패로 끝난 청구는 요청을 만들지 않는다
    const other = await paidPayment({ status: "PENDING" });
    await db.sellerSubscription.update({ where: { id: other.sub.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    await settlePayment(db, other.payment.id, { ok: false, reason: "card_declined" }, { actorType: "SYSTEM", actorId: null });
    expect(await db.subscriptionRefund.count({ where: { paymentId: other.payment.id } })).toBe(0);
  });
});

describe("권한·직접 요청", () => {
  it("보기는 모든 역할, 요청은 최고관리자·운영만, 승인·거절은 최고관리자만. 거절 권한 실패 시 다른 판매자 요청도 유지한다", async () => {
    const { payment } = await paidPayment();
    const ops = await adminCookie("OPERATIONS");
    for (const role of ["CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      expect((await create(a.cookie, { paymentId: payment.id, amount: 1000, reason: "법정 환불" })).status).toBe(403);
    }
    const made = await create(ops.cookie, { paymentId: payment.id, amount: 50_000, reason: "청약 철회" });
    expect(made.status).toBe(201);
    expect(made.body.refund).toMatchObject({ source: "ADMIN", status: "REQUESTED", amount: 50_000, reason: "청약 철회", requestedByAdminId: ops.id, payment: { amount: 199_000 } });
    const id = made.body.refund.id;
    const detail = await json(await getRoute(req(`/api/admin/subscription-refunds/${id}`, ops.cookie), p(id)));
    expect(detail.body.refund.history.map((event: { action: string }) => event.action)).toEqual(["subscription.refund.request"]);
    for (const role of ["CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      expect((await json(await listRoute(req("/api/admin/subscription-refunds", a.cookie)))).status).toBe(200);
      expect((await getRoute(req(`/api/admin/subscription-refunds/${id}`, a.cookie), p(id))).status).toBe(200);
      expect((await approve(a.cookie, id, { expectedVersion: 0 })).status).toBe(403);
      expect((await reject(a.cookie, id, { note: "x", expectedVersion: 0 })).status).toBe(403);
    }
    expect((await approve(ops.cookie, id, { expectedVersion: 0 })).status).toBe(403);
    expect((await db.subscriptionRefund.findUniqueOrThrow({ where: { id } })).status).toBe("REQUESTED");
    const otherPayment = await paidPayment();
    const su = await adminCookie("SUPER_ADMIN");
    const other = await create(su.cookie, { paymentId: otherPayment.payment.id, amount: 1000, reason: "다른 판매자 요청" });
    expect(other.status).toBe(201);
    expect((await reject(ops.cookie, id, { note: "운영 반려", expectedVersion: 0 })).status).toBe(403);
    expect((await db.subscriptionRefund.findUniqueOrThrow({ where: { id } })).status).toBe("REQUESTED");
    expect((await db.subscriptionRefund.findUniqueOrThrow({ where: { id: other.body.refund.id } })).status).toBe("REQUESTED");
    expect((await reject(su.cookie, id, { note: "최고관리자 판단", expectedVersion: 0 })).body.refund).toMatchObject({ status: "REJECTED", sellerId: payment.sellerId });
    expect((await db.subscriptionRefund.findUniqueOrThrow({ where: { id: other.body.refund.id } })).status).toBe("REQUESTED");
    expect((await json(await listRoute(req("/api/admin/subscription-refunds", "")))).status).toBe(401);
    expect(await db.auditLog.count({ where: { action: "subscription.refund.request", targetId: id, actorId: ops.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "subscription.refund.approve", targetId: id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "subscription.refund.reject", targetId: id, actorId: ops.id } })).toBe(0);
  });

  it("금액·사유·청구 상태를 검사하고, 같은 청구에 진행 중인 요청이 있으면 409. 반려된 뒤에는 다시 요청할 수 있다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const { payment } = await paidPayment();
    const pending = await paidPayment({ status: "PENDING" });
    expect((await create(su.cookie, { paymentId: payment.id, amount: 0, reason: "x" })).body.error).toBe("invalid_amount");
    expect((await create(su.cookie, { paymentId: payment.id, amount: 199_001, reason: "x" })).body.error).toBe("invalid_amount");
    expect((await create(su.cookie, { paymentId: payment.id, amount: 1000, reason: "" })).body.error).toBe("invalid_reason");
    expect((await create(su.cookie, { paymentId: pending.payment.id, amount: 1000, reason: "x" })).body.error).toBe("payment_not_paid");
    expect((await create(su.cookie, { paymentId: crypto.randomUUID(), amount: 1000, reason: "x" })).status).toBe(404);
    const first = await create(su.cookie, { paymentId: payment.id, amount: 199_000, reason: "전액" });
    expect(first.status).toBe(201);
    const dup = await create(su.cookie, { paymentId: payment.id, amount: 1000, reason: "또" });
    expect(dup).toMatchObject({ status: 409, body: { error: "already_requested" } });
    expect((await reject(su.cookie, first.body.refund.id, { note: "중복 요청", expectedVersion: 0 })).body.refund).toMatchObject({ status: "REJECTED", decisionNote: "중복 요청" });
    expect((await create(su.cookie, { paymentId: payment.id, amount: 1000, reason: "다시" })).status).toBe(201);
  });
});

describe("승인·반려", () => {
  it("승인하면 공급자에 취소를 요청하고 환불됨으로 끝난다. 끝난 환불은 다시 승인·반려할 수 없고, 옛 version은 409", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const { payment } = await paidPayment();
    const id = (await create(su.cookie, { paymentId: payment.id, amount: 30_000, reason: "부분 환불" })).body.refund.id;
    const before = pg().cancels.length;
    expect(await approve(su.cookie, id, { expectedVersion: 5 })).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 0 } });
    const ok = await approve(su.cookie, id, { expectedVersion: 0, note: "확인함" });
    expect(ok.status).toBe(200);
    expect(ok.body.refund).toMatchObject({ status: "REFUNDED", decidedByAdminId: su.id, decisionNote: "확인함", refundedAt: expect.any(String), version: 2 });
    expect(pg().cancels.slice(before)).toEqual([{ refundId: id, paymentId: payment.providerPaymentId, amount: 30_000 }]);
    expect((await approve(su.cookie, id, { expectedVersion: 2 })).body.error).toBe("not_decidable");
    expect((await reject(su.cookie, id, { note: "x", expectedVersion: 2 })).body.error).toBe("not_decidable");
    expect((await db.auditLog.findMany({ where: { targetType: "SubscriptionRefund", targetId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((a) => a.action)).toEqual([
      "subscription.refund.request",
      "subscription.refund.approve",
      "subscription.refund.refunded",
    ]);
    expect((await json(await getRoute(req(`/api/admin/subscription-refunds/${id}`, su.cookie), p(id)))).body.refund.history.map((event: { action: string }) => event.action)).toEqual([
      "subscription.refund.request",
      "subscription.refund.approve",
      "subscription.refund.refunded",
    ]);
  });

  it("공급자가 거절하면 실패로 남고, 응답이 끊기면 처리 중으로 남는다. 다시 승인하면 같은 환불로 한 번만 취소된다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const { payment } = await paidPayment();
    const id = (await create(su.cookie, { paymentId: payment.id, amount: 10_000, reason: "x" })).body.refund.id;
    pg().rejectNextCancel = "already_canceled";
    const failed = await approve(su.cookie, id, { expectedVersion: 0 });
    expect(failed.body.refund).toMatchObject({ status: "FAILED", failureReason: "already_canceled", version: 2 });
    // 응답 끊김
    const provider = pg();
    const orig = provider.cancelPayment.bind(provider);
    provider.cancelPayment = async (input) => {
      await orig(input);
      throw new Error("PG 응답 시간 초과");
    };
    try {
      const lost = await approve(su.cookie, id, { expectedVersion: 2 });
      expect(lost.body.refund).toMatchObject({ status: "PROCESSING", version: 3 });
    } finally {
      provider.cancelPayment = orig;
    }
    const done = await approve(su.cookie, id, { expectedVersion: 3 });
    expect(done.body.refund).toMatchObject({ status: "REFUNDED", failureReason: null });
    expect(pg().cancels.filter((c) => c.refundId === id)).toHaveLength(1);
  });

  it("실패한 환불이 있는 청구에 새 요청을 만든 뒤 옛 요청을 다시 승인하면 409 already_requested(취소 요청 없음)", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const { payment } = await paidPayment();
    const oldId = (await create(su.cookie, { paymentId: payment.id, amount: 10_000, reason: "x" })).body.refund.id;
    pg().rejectNextCancel = "temporary_error";
    expect((await approve(su.cookie, oldId, { expectedVersion: 0 })).body.refund).toMatchObject({ status: "FAILED", version: 2 });
    expect((await create(su.cookie, { paymentId: payment.id, amount: 10_000, reason: "새 요청" })).status).toBe(201);
    const before = pg().cancels.length;
    expect(await approve(su.cookie, oldId, { expectedVersion: 2 })).toMatchObject({ status: 409, body: { error: "already_requested" } });
    expect(pg().cancels.length).toBe(before);
    expect((await db.subscriptionRefund.findUniqueOrThrow({ where: { id: oldId } })).status).toBe("FAILED");
  });

  it("같은 version으로 동시에 두 번 승인하면 하나만 된다(취소도 한 번)", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const { payment } = await paidPayment();
    const id = (await create(su.cookie, { paymentId: payment.id, amount: 5_000, reason: "x" })).body.refund.id;
    const rs = await Promise.all([approve(su.cookie, id, { expectedVersion: 0 }), approve(su.cookie, id, { expectedVersion: 0 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(pg().cancels.filter((c) => c.refundId === id)).toHaveLength(1);
  });

  it("반려는 사유가 있어야 하고, 결제 번호가 없는 청구는 승인할 수 없다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const { payment } = await paidPayment();
    const id = (await create(su.cookie, { paymentId: payment.id, amount: 5_000, reason: "x" })).body.refund.id;
    expect((await reject(su.cookie, id, { note: "", expectedVersion: 0 })).body.error).toBe("invalid_reason");
    await db.subscriptionPayment.update({ where: { id: payment.id }, data: { providerPaymentId: null } });
    expect((await approve(su.cookie, id, { expectedVersion: 0 })).body.error).toBe("provider_payment_missing");
  });
});

describe("목록", () => {
  it("요청 최신 순 50건씩 커서, 상태로 거르고 상태별 수를 준다. 쇼핑몰 이름·주소와 청구 기간이 함께 온다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) {
      const { payment } = await paidPayment();
      const r = await db.subscriptionRefund.create({
        data: { sellerId: payment.sellerId, paymentId: payment.id, amount: 1000, source: "SYSTEM", reason: "paid_after_cancel", createdAt: new Date(Date.now() - (60 - i) * 1000) },
      });
      ids.push(r.id);
    }
    await db.subscriptionRefund.update({ where: { id: ids[0] }, data: { status: "REJECTED" } });
    const first = await json(await listRoute(req("/api/admin/subscription-refunds", su.cookie)));
    expect(first.body.items).toHaveLength(50);
    expect(first.body.items[0]).toMatchObject({ id: ids[51], shopName: expect.any(String), slug: expect.any(String), payment: { amount: 199_000, kind: "PERIOD" } });
    expect(first.body.counts).toEqual({ REQUESTED: 51, PROCESSING: 0, REFUNDED: 0, FAILED: 0, REJECTED: 1 });
    const second = await json(await listRoute(req(`/api/admin/subscription-refunds?cursor=${encodeURIComponent(first.body.nextCursor)}`, su.cookie)));
    expect(second.body.items.map((r: { id: string }) => r.id)).toEqual([ids[1], ids[0]]);
    const rejected = await json(await listRoute(req("/api/admin/subscription-refunds?status=REJECTED", su.cookie)));
    expect(rejected.body.items.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
    expect((await listRoute(req("/api/admin/subscription-refunds?status=NOPE", su.cookie))).status).toBe(400);
  });
});
