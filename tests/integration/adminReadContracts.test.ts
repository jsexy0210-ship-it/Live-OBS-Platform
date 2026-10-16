import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerRoute } from "../../app/api/admin/sellers/[sellerId]/route";
import { GET as paymentRoute } from "../../app/api/admin/payments/[paymentId]/route";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { getAdminPayment } from "../../lib/server/admin/billing";
import { getAdminSeller } from "../../lib/server/admin/sellers";
import { createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

beforeEach(resetDb);
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });

async function admin(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  const session = await createAdminSession(db, a.id, {});
  const ctx = await resolveAdminSession(db, session.token);
  if (!ctx) throw new Error("missing admin");
  return { a, ctx, cookie: `lo_admin=${session.token}` };
}
async function billing() {
  const plans = await seedPlans();
  const { seller } = await createSeller();
  const periodStart = new Date("2026-10-01T00:00:00Z"), periodEnd = new Date("2026-11-01T00:00:00Z");
  const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plans.INTEGRATED.id, subscribedAt: periodStart,
    status: "PAST_DUE", cardLabel: "테스트카드 ****1234", billingKeyCipher: "PRIVATE-BILLING-CIPHER", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } });
  const payment = await db.subscriptionPayment.create({ data: { sellerId: seller.id, subscriptionId: sub.id, periodStart, periodEnd,
    amount: 179000, status: "FAILED", scheduled: true, createdAt: new Date(Date.now() - 600_000), failureReason: "card_declined" } });
  return { plans, seller, sub, payment, periodStart, periodEnd };
}

describe("MA014 신청 처리 이력", () => {
  it("모든 조회 관리자에게 해당 판매자/대상/신청 처리만 제공하며 원문 감사 데이터는 제외한다", async () => {
    const { seller } = await createSeller();
    const other = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const reviewer = await admin("OPERATIONS");
    const at = new Date("2026-10-06T00:00:00Z");
    await db.auditLog.createMany({ data: [
      { actorType: "SELLER_USER", actorId: owner.id, sellerId: seller.id, targetType: "Seller", targetId: seller.id, action: "seller.apply", createdAt: at, after: { token: "PRIVATE-AFTER" }, ip: "PRIVATE-IP" },
      { actorType: "PLATFORM_ADMIN", actorId: reviewer.a.id, sellerId: seller.id, targetType: "Seller", targetId: seller.id, action: "admin.seller.supplement_request", reason: "증빙 보완", createdAt: new Date(at.getTime() + 1000), before: { password: "PRIVATE-BEFORE" }, userAgent: "PRIVATE-UA" },
      { actorType: "SYSTEM", sellerId: other.seller.id, targetType: "Seller", targetId: seller.id, action: "admin.seller.reject", reason: "다른 테넌트" },
      { actorType: "SYSTEM", sellerId: seller.id, targetType: "Seller", targetId: other.seller.id, action: "admin.seller.reject", reason: "다른 대상" },
      { actorType: "SYSTEM", sellerId: seller.id, targetType: "Order", targetId: seller.id, action: "admin.seller.reject", reason: "다른 대상 종류" },
      { actorType: "SYSTEM", sellerId: seller.id, targetType: "Seller", targetId: seller.id, action: "admin.seller.suspend", reason: "신청 밖 행동" },
    ] });
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const viewer = await admin(role);
      const view = await getAdminSeller(db, viewer.ctx, seller.id);
      expect(view?.processingHistorySource).toBe("APPLICATION_AUDIT");
      expect(view?.processingHistoryTruncated).toBe(false);
      expect(view?.processingHistory.map((h) => h.action)).toEqual(["seller.apply", "admin.seller.supplement_request"]);
      expect(view?.processingHistory[0].actor).toMatchObject({ name: owner.name, role: "OWNER" });
      expect(view?.processingHistory[1]).toMatchObject({ at: new Date(at.getTime() + 1000), reason: "증빙 보완", actor: { name: reviewer.a.name, role: "OPERATIONS" } });
      const history = JSON.stringify(view?.processingHistory);
      for (const marker of ["PRIVATE-AFTER", "PRIVATE-BEFORE", "PRIVATE-IP", "PRIVATE-UA", "다른 테넌트", "다른 대상", "신청 밖 행동"]) expect(history).not.toContain(marker);
      expect(view?.processingHistory[0].actor).not.toHaveProperty("id");
    }
  });
  it("이력은 최근 100건으로 제한하고 분실한 행위자 이름을 추정하지 않는다", async () => {
    const { seller } = await createSeller();
    const viewer = await admin("READ_ONLY");
    await db.auditLog.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ sellerId: seller.id, targetType: "Seller", targetId: seller.id,
      actorType: "SYSTEM" as const, action: "admin.seller.business_recheck", createdAt: new Date(1760000000000 + i * 1000) })) });
    const view = await getAdminSeller(db, viewer.ctx, seller.id);
    expect(view?.processingHistory).toHaveLength(100);
    expect(view?.processingHistoryTruncated).toBe(true);
    expect(view?.processingHistory[0]).toMatchObject({ at: new Date(1760000001000), actor: { type: "SYSTEM", name: null, role: null } });
  });
});

describe("MA025 저장 시도 이력·읽기 재시도 판정", () => {
  it("같은 판매자/구독/기간/종류/목표 요금제의 실제 기록만 조회하고 조회로 금융 상태를 바꾸지 않는다", async () => {
    const s = await billing();
    const viewer = await admin("OPERATIONS");
    const base = { sellerId: s.seller.id, subscriptionId: s.sub.id, periodStart: s.periodStart, periodEnd: s.periodEnd, amount: 179000, status: "FAILED" as const, createdAt: new Date(Date.now() - 3600_000) };
    const first = await db.subscriptionPayment.create({ data: { ...base, scheduled: false, failureReason: "first_decline" } });
    await db.subscriptionPayment.createMany({ data: [
      { ...base, periodEnd: new Date("2026-12-01T00:00:00Z") },
      { ...base, kind: "PRORATION" },
      { ...base, targetPlanId: s.plans.OVERLAY_ONLY.id },
    ] });
    const foreign = await billing();
    const before = await db.sellerSubscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    const count = await db.subscriptionPayment.count();
    const view = await getAdminPayment(db, viewer.ctx, s.payment.id);
    expect(view?.attemptHistorySource).toBe("SUBSCRIPTION_PERIOD_PAYMENTS");
    expect(view?.attemptHistory.map((a) => a.id)).toEqual([first.id, s.payment.id]);
    expect(view?.attemptHistory).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: foreign.payment.id })]));
    expect(view?.canRetry).toBe(true);
    expect(view?.retryUnavailableReason).toBeNull();
    expect(JSON.stringify(view)).not.toContain("PRIVATE-BILLING-CIPHER");
    expect(view?.subscription).not.toHaveProperty("billingKeyCipher");
    expect(view?.attemptHistory[0]).not.toHaveProperty("providerPaymentId");
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: s.sub.id } })).toEqual(before);
    expect(await db.subscriptionPayment.count()).toBe(count);
  });
  it("조회 전용/CS는 실행 권한이 없고 5분/최신 청구/구독 판정을 그대로 따른다", async () => {
    const s = await billing();
    for (const role of ["CS", "READ_ONLY"] as const) {
      const viewer = await admin(role);
      expect(await getAdminPayment(db, viewer.ctx, s.payment.id)).toMatchObject({ canRetry: false, retryUnavailableReason: "permission_denied" });
    }
    const viewer = await admin("SUPER_ADMIN");
    const recent = new Date();
    await db.subscriptionPayment.update({ where: { id: s.payment.id }, data: { createdAt: recent } });
    expect(await getAdminPayment(db, viewer.ctx, s.payment.id)).toMatchObject({ canRetry: false, retryUnavailableReason: "too_soon", canRetryAt: new Date(recent.getTime() + 300_000) });
    await db.subscriptionPayment.update({ where: { id: s.payment.id }, data: { createdAt: new Date(Date.now() - 600_000) } });
    await db.sellerSubscription.update({ where: { id: s.sub.id }, data: { cancelAtPeriodEnd: true } });
    expect(await getAdminPayment(db, viewer.ctx, s.payment.id)).toMatchObject({ canRetry: false, retryUnavailableReason: "not_retryable" });
    await db.sellerSubscription.update({ where: { id: s.sub.id }, data: { cancelAtPeriodEnd: false } });
    await db.subscriptionPayment.create({ data: { sellerId: s.seller.id, subscriptionId: s.sub.id, periodStart: s.periodStart, periodEnd: s.periodEnd, amount: 179000, status: "PAID" } });
    expect(await getAdminPayment(db, viewer.ctx, s.payment.id)).toMatchObject({ canRetry: false, retryUnavailableReason: "not_latest" });
  });
  it("시도 이력 100건 경계를 명시한다", async () => {
    const s = await billing();
    const viewer = await admin("READ_ONLY");
    await db.subscriptionPayment.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ sellerId: s.seller.id, subscriptionId: s.sub.id,
      periodStart: s.periodStart, periodEnd: s.periodEnd, amount: 179000, status: "FAILED" as const, createdAt: new Date(Date.now() - 3600_000 + i * 1000) })) });
    const view = await getAdminPayment(db, viewer.ctx, s.payment.id);
    expect(view?.attemptHistory).toHaveLength(100);
    expect(view?.attemptHistoryTruncated).toBe(true);
    expect(view?.attemptHistory.at(-1)?.id).toBe(s.payment.id);
  });
});

it("기존 관리자 상세 API는 조회 권한과 성공/404/401 no-store를 유지한다", async () => {
  const s = await billing();
  const viewer = await admin("CS");
  for (const [id, key] of [[s.seller.id, "sellerId"], [s.payment.id, "paymentId"]] as const) {
    const request = new Request("http://localhost:3000/x", { headers: { cookie: viewer.cookie } });
    const result = key === "sellerId" ? await sellerRoute(request, { params: Promise.resolve({ sellerId: id }) }) : await paymentRoute(request, { params: Promise.resolve({ paymentId: id }) });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    const denied = key === "sellerId" ? await sellerRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ sellerId: id }) }) : await paymentRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ paymentId: id }) });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toContain("no-store");
    const missing = key === "sellerId" ? await sellerRoute(request, { params: Promise.resolve({ sellerId: "bad" }) }) : await paymentRoute(request, { params: Promise.resolve({ paymentId: "bad" }) });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toContain("no-store");
  }
});
