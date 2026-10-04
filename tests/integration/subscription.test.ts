import type { TenantContext } from "../../lib/server/tenant/context";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loginSeller } from "../../lib/server/auth/login";
import { resolveAdminSession, createAdminSession } from "../../lib/server/auth/session";
import { requireSeller } from "../../lib/server/authz/guards";
import { listPriceChangeNoticeTargets, updatePlanPrice } from "../../lib/server/billing/plans";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { addMonthsKst } from "../../lib/server/billing/access";
import { openBillingKey } from "../../lib/server/billing/secret";
import {
  cancelSubscription,
  closeLongLockedSellers,
  reconcileStalePayments,
  getSubscriptionView,
  registerCardAndPay,
  renewDueSubscriptions,
  sellerAccessFor,
} from "../../lib/server/billing/subscription";
import { checkTrialLimit, updateTrialLimits } from "../../lib/server/billing/trialLimits";
import { POST as broadcastStart } from "../../app/api/seller/broadcast/start/route";
import { GET as orderRoute } from "../../app/api/seller/orders/[orderId]/route";
import { POST as refundRoute } from "../../app/api/seller/orders/[orderId]/refund/route";
import { markOrderPaid } from "../../lib/server/queue/service";
import { GET as overlayState } from "../../app/api/overlay/[token]/state/route";
import { GET as overlayStream } from "../../app/api/overlay/[token]/stream/route";
import { GET as overlayVersion } from "../../app/api/overlay/[token]/version/route";
import { issueOverlayToken } from "../../lib/server/overlay/token";
import { liveHub } from "../../lib/server/realtime/hub";
import { SSE_CONFIG } from "../../lib/server/realtime/sse";
import { approveSeller } from "../../lib/server/sellers/approval";
import { POST as approveRoute } from "../../app/api/admin/sellers/[sellerId]/approve/route";
import { GET as plansRoute } from "../../app/api/plans/route";
import { POST as sellerLogin } from "../../app/api/seller/auth/login/route";
import { POST as sellerLogout } from "../../app/api/seller/auth/logout/route";
import { GET as sellerMe } from "../../app/api/seller/me/route";
import { GET as queueRoute } from "../../app/api/seller/queue/route";
import { GET as subscriptionRoute } from "../../app/api/seller/subscription/route";
import { POST as cardRoute } from "../../app/api/seller/subscription/card/route";
import { POST as cancelRoute } from "../../app/api/seller/subscription/cancel/route";
import { POST as adminLogin } from "../../app/api/admin/auth/login/route";
import { prisma } from "../../lib/server/db";
import { PASSWORD, adminCredentials, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
});
beforeEach(async () => {
  await resetDb();
  plans = await seedPlans();
});
let plans: Awaited<ReturnType<typeof seedPlans>>;
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const ownerCtx = (sellerId: string, actorId: string): TenantContext => ({
  sellerId,
  actorType: "SELLER_USER",
  actorId,
  isOwner: true,
  permissions: [],
  readOnly: false,
});

async function adminCtx(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const admin = await createAdmin(role);
  const s = await createAdminSession(db, admin.id, {});
  return (await resolveAdminSession(db, s.token))!;
}

// 체험하기 종료 시각을 정한 쇼핑몰과 대표자. 이 파일의 결제 엔진 시험(재시도·유예·가격 기록 등 플랜과 무관한 규칙)은
// 이전 전 플랜 STANDARD(300,000/199,000원)로 돈다. 플랜별 규칙(ONQ 1-C)은 planMigration.test.ts가 본다.
async function shop(trialEndsAt: Date | null) {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt, planId: plans.STANDARD.id } });
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner, ctx: ownerCtx(seller.id, owner.id) };
}

async function sessionToken(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return r.token;
}

describe("판매자 승인과 체험하기", () => {
  it("승인하면 ACTIVE가 되고 체험은 판매자 플랜대로(오버레이 전용 = 승인 + 7일, 통합·플랜 없음 = 체험 없음, DB 시계), 다시 승인할 수 없다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    const overlay = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    const o = await db.seller.create({ data: { slug: "pending-overlay", shopName: "오버레이 쇼핑몰", planId: overlay.id } });
    expect((await approveSeller(db, admin, o.id)).ok).toBe(true);
    const savedO = await db.seller.findUniqueOrThrow({ where: { id: o.id } });
    expect(savedO.trialEndsAt!.getTime() - savedO.approvedAt!.getTime()).toBe(7 * DAY);
    const seller = await db.seller.create({ data: { slug: "pending-shop", shopName: "대기 쇼핑몰" } });
    const r = await approveSeller(db, admin, seller.id);
    expect(r.ok).toBe(true);
    const saved = await db.seller.findUniqueOrThrow({ where: { id: seller.id } });
    expect(saved.status).toBe("ACTIVE");
    // 플랜이 없던 판매자는 신규 가입 기본 플랜(통합)으로 정해 남기고 체험은 없다
    expect(saved.trialEndsAt).toBeNull();
    expect(saved.planId).toBe((await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } })).id);
    expect(saved.approvedByAdminId).toBe(admin.admin.id);
    expect(await approveSeller(db, admin, seller.id)).toEqual({ ok: false, reason: "not_pending" });
    expect(await db.auditLog.count({ where: { action: "admin.seller.approve", targetId: seller.id } })).toBe(1);
  });

  it("동시에 두 번 승인해도 한 번만 승인된다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    const seller = await db.seller.create({ data: { slug: "race-shop", shopName: "동시" } });
    const rs = await Promise.all([approveSeller(db, admin, seller.id), approveSeller(db, admin, seller.id)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("조회 전용·CS 마스터 역할은 승인할 수 없다", async () => {
    const seller = await db.seller.create({ data: { slug: "ro-shop", shopName: "조회" } });
    await expect(approveSeller(db, await adminCtx("READ_ONLY"), seller.id)).rejects.toMatchObject({ status: 403 });
    await expect(approveSeller(db, await adminCtx("CS"), seller.id)).rejects.toMatchObject({ status: 403 });
  });

  it("체험하기 중에는 쓸 수 있고, 끝나면 판매자 API가 402로 막힌다(구독 화면만 열림)", async () => {
    const a = await shop(new Date(Date.now() + DAY));
    await expect(requireSeller(db, await sessionToken(a.owner.email))).resolves.toMatchObject({ sellerId: a.seller.id });

    const b = await shop(new Date(Date.now() - 1000));
    const token = await sessionToken(b.owner.email);
    await expect(requireSeller(db, token)).rejects.toMatchObject({ status: 402, code: "subscription_required" });
    await expect(requireSeller(db, token, new Date(), { allowUnpaid: true })).resolves.toMatchObject({ sellerId: b.seller.id });

    // 체험하기 종료 값이 없으면(승인 기록 없음) 막는다
    const c = await shop(null);
    await expect(requireSeller(db, await sessionToken(c.owner.email))).rejects.toMatchObject({ status: 402 });
  });
});

describe("카드 등록·결제", () => {
  it("체험하기 중에 구독하면 카드만 등록하고, 체험하기가 끝난 뒤 예약 실행이 199,000원을 처음 결제한다(기간은 결제한 시각부터)", async () => {
    const trialEndsAt = new Date(Date.now() + 2 * DAY);
    const { seller, ctx } = await shop(trialEndsAt);
    const provider = new FakeBillingProvider();
    const r = await registerCardAndPay(db, provider, ctx, { authKey: "auth-1" });
    expect(r).toMatchObject({ ok: true, charged: false, nextChargeAt: trialEndsAt });
    expect(provider.charges).toHaveLength(0);
    expect(await db.subscriptionPayment.count()).toBe(0);

    // 체험하기 종료 전에는 결제하지 않는다
    expect(await renewDueSubscriptions(db, provider, { now: new Date(trialEndsAt.getTime() - 1000) })).toMatchObject({ charged: 0 });
    // 체험하기가 끝나고 예약 실행이 돌기 전에도 끊기지 않는다
    expect(await sellerAccessFor(db, seller.id, new Date(trialEndsAt.getTime() + 60_000))).toBe("charging");
    const chargedAt = new Date(trialEndsAt.getTime() + 60_000);
    expect(await renewDueSubscriptions(db, provider, { now: chargedAt })).toMatchObject({ charged: 1 });
    expect(provider.charges).toEqual([expect.objectContaining({ amount: 199000 })]);
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } });
    // 체험 종료와 결제 사이(잠금 대기)는 청구하지 않으므로 기간은 결제한 시각부터 한 달(KST 기준일)
    expect(sub).toMatchObject({ status: "ACTIVE", currentPeriodStart: chargedAt, currentPeriodEnd: addMonthsKst(chargedAt, 1), billingAnchorAt: chargedAt });
    expect(sub.nextChargeAt).toEqual(new Date(addMonthsKst(chargedAt, 1).getTime() - DAY));
    // 빌링키 원문은 저장하지 않는다
    expect(JSON.stringify(sub)).not.toContain("fake-bk-");
  });

  it("체험하기 중에 해지하면 청구하지 않는다", async () => {
    const trialEndsAt = new Date(Date.now() + DAY);
    const { seller, ctx } = await shop(trialEndsAt);
    const provider = new FakeBillingProvider();
    await registerCardAndPay(db, provider, ctx, { authKey: "auth-c" });
    expect(await cancelSubscription(db, ctx)).toMatchObject({ ok: true, currentPeriodEnd: null });
    expect(await renewDueSubscriptions(db, provider, { now: new Date(trialEndsAt.getTime() + 60_000) })).toMatchObject({ charged: 0 });
    expect(provider.charges).toHaveLength(0);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } })).status).toBe("CANCELED");
    expect(await sellerAccessFor(db, seller.id, new Date(trialEndsAt.getTime() + 60_000))).toBe("expired");
  });

  it("체험하기가 끝나 잠긴 뒤 구독하면 바로 결제하고, 지금부터 한 달이 시작된다", async () => {
    const { owner, seller, ctx } = await shop(new Date(Date.now() - 2 * DAY));
    const token = await sessionToken(owner.email);
    await expect(requireSeller(db, token)).rejects.toMatchObject({ status: 402 });
    const now = new Date();
    expect(await registerCardAndPay(db, new FakeBillingProvider(), ctx, { authKey: "auth-2", now })).toMatchObject({ ok: true, charged: true });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } })).currentPeriodStart).toEqual(now);
    await expect(requireSeller(db, token)).resolves.toMatchObject({ isOwner: true });
  });

  it("카드가 거절되거나 결제가 실패하면 잠긴 그대로고, 실패한 청구가 남는다", async () => {
    const { owner, seller, ctx } = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "reject-1" })).toEqual({ ok: false, reason: "card_rejected" });
    const declining = new (class extends FakeBillingProvider {
      async charge() {
        return { ok: false as const, reason: "card_declined" };
      }
    })();
    expect(await registerCardAndPay(db, declining, ctx, { authKey: "auth-3" })).toEqual({ ok: false, reason: "payment_failed" });
    expect((await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: seller.id } })).status).toBe("FAILED");
    await expect(requireSeller(db, await sessionToken(owner.email))).rejects.toMatchObject({ status: 402 });
    // 다른 카드로 다시 시도할 수 있다
    expect((await registerCardAndPay(db, provider, ctx, { authKey: "auth-4" })).ok).toBe(true);
  });

  it("결제한 기간이 남아 있으면 카드만 바꾸고 결제하지 않는다", async () => {
    const { seller, ctx } = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    await registerCardAndPay(db, provider, ctx, { authKey: "a" });
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "b" })).toMatchObject({ ok: true, charged: false });
    expect(provider.charges).toHaveLength(1);
    expect(await db.subscriptionPayment.count({ where: { sellerId: seller.id } })).toBe(1);
  });

  it("동시에 두 번 눌러도 한 번만 결제된다", async () => {
    const { seller, ctx } = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    const rs = await Promise.all([
      registerCardAndPay(db, provider, ctx, { authKey: "x" }),
      registerCardAndPay(db, provider, ctx, { authKey: "y" }),
    ]);
    expect(rs.every((r) => r.ok || r.reason === "payment_in_progress")).toBe(true);
    expect(provider.charges).toHaveLength(1);
    expect(await db.subscriptionPayment.count({ where: { sellerId: seller.id, status: "PAID" } })).toBe(1);
  });

  it("구독은 대표자만: 직원·마스터 대리 조회는 결제·조회할 수 없다", async () => {
    const { seller } = await shop(new Date(Date.now() + DAY));
    const staff = await createSellerUser(seller.id, "MANAGER");
    const staffCtx: TenantContext = { ...ownerCtx(seller.id, staff.id), isOwner: false, permissions: [...staff.permissions] };
    const provider = new FakeBillingProvider();
    await expect(registerCardAndPay(db, provider, staffCtx, { authKey: "s" })).rejects.toMatchObject({ status: 403 });
    await expect(getSubscriptionView(db, staffCtx)).rejects.toMatchObject({ status: 403 });
    await expect(cancelSubscription(db, staffCtx)).rejects.toMatchObject({ status: 403 });
    const impersonation: TenantContext = { ...ownerCtx(seller.id, "00000000-0000-0000-0000-000000000000"), actorType: "PLATFORM_ADMIN", isOwner: false, readOnly: true };
    await expect(registerCardAndPay(db, provider, impersonation, { authKey: "s" })).rejects.toMatchObject({ status: 403 });
    expect(provider.charges).toHaveLength(0);
  });
});

describe("가격", () => {
  it("가격을 바꾸면 새 가입자는 바로, 기존 구독자는 변경 + 30일 이후 첫 결제부터 새 가격이다", async () => {
    const provider = new FakeBillingProvider();
    const old = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, old.ctx, { authKey: "old" });
    const oldSub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: old.seller.id } });

    const admin = await adminCtx("SUPER_ADMIN");
    const r = await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 249000 });
    expect(r).toMatchObject({ ok: true, plan: { salePrice: 249000 } });
    const changedAt = (await db.subscriptionPriceChange.findFirstOrThrow({ orderBy: { changedAt: "desc" } })).changedAt;

    // 새 가입자: 바로 새 가격
    const fresh = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, fresh.ctx, { authKey: "new" });
    expect(provider.charges.at(-1)!.amount).toBe(249000);

    // 기존 구독자: 변경 뒤 30일 안의 결제는 이전 가격, 30일이 지난 뒤 결제는 새 가격
    // (기존 구독자의 기간 끝을 변경 + 10일로 옮겨 30일 안에 다음 결제가 오게 한다)
    const end = new Date(changedAt.getTime() + 10 * DAY);
    await db.sellerSubscription.update({
      where: { id: oldSub.id },
      data: { currentPeriodEnd: end, nextChargeAt: new Date(end.getTime() - DAY), billingAnchorAt: addMonthsKst(end, -1) },
    });
    await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) });
    expect(provider.charges.at(-1)!.amount).toBe(199000);
    const afterRenew = await db.sellerSubscription.findUniqueOrThrow({ where: { id: oldSub.id } });
    await renewDueSubscriptions(db, provider, { now: new Date(afterRenew.currentPeriodEnd!.getTime() - DAY / 2) });
    expect(provider.charges.at(-1)!.amount).toBe(249000);

    // 고지 대상: 변경 전부터 구독하던 판매자만
    const targets = await listPriceChangeNoticeTargets(db, admin);
    expect(targets.map((t) => t.sellerId)).toEqual([old.seller.id]);
    expect(targets[0]).toMatchObject({ oldPrice: 199000, newPrice: 249000, appliesFrom: new Date(changedAt.getTime() + 30 * DAY) });
    expect(await db.auditLog.count({ where: { action: "admin.plan.price_update" } })).toBe(1);
  });

  it("판매가가 정가보다 크거나 정수가 아니면 거부, 최고관리자가 아니면 바꿀 수 없다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    expect(await updatePlanPrice(db, admin, "STANDARD", { listPrice: 100000, salePrice: 199000 })).toEqual({ ok: false, reason: "invalid_price" });
    expect(await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 1.5 })).toEqual({ ok: false, reason: "invalid_price" });
    await expect(updatePlanPrice(db, await adminCtx("CS"), "STANDARD", { listPrice: 1, salePrice: 1 })).rejects.toMatchObject({ status: 403 });
    // 가격 변경은 최고관리자만(운영 역할도 불가)
    await expect(updatePlanPrice(db, await adminCtx("OPERATIONS"), "STANDARD", { listPrice: 300000, salePrice: 1000 })).rejects.toMatchObject({ status: 403 });
    expect((await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } })).salePrice).toBe(199000);
  });
});

describe("자동결제·재시도·해지", () => {
  async function paidShop(provider: FakeBillingProvider) {
    const s = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, s.ctx, { authKey: `k-${s.seller.id}` });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    return { ...s, sub };
  }
  const declineStored = async (provider: FakeBillingProvider, subId: string) => {
    const stored = await db.sellerSubscription.findUniqueOrThrow({ where: { id: subId } });
    provider.decline(openBillingKey(stored.billingKeyCipher!, stored.sellerId));
  };

  it("기간 끝 하루 전부터 다음 달을 결제하고, 여러 번 돌려도 한 번만 결제한다", async () => {
    const provider = new FakeBillingProvider();
    const { sub } = await paidShop(provider);
    const end = sub.currentPeriodEnd!;
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - 2 * DAY) })).toMatchObject({ charged: 0 });
    const now = new Date(end.getTime() - DAY / 2);
    expect(await renewDueSubscriptions(db, provider, { now })).toMatchObject({ charged: 1 });
    const again = await Promise.all([renewDueSubscriptions(db, provider, { now }), renewDueSubscriptions(db, provider, { now })]);
    expect(again.reduce((n, s) => n + s.charged, 0)).toBe(0);
    expect(provider.charges).toHaveLength(2);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodStart).toEqual(end);
  });

  it("자동결제가 실패하면 하루 간격으로 3번 다시 시도하고, 실패한 때부터 7일 유예 뒤 잠긴다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, seller } = await paidShop(provider);
    await declineStored(provider, sub.id);
    const end = sub.currentPeriodEnd!;
    const t0 = new Date(end.getTime() - DAY / 2);
    expect(await renewDueSubscriptions(db, provider, { now: t0 })).toMatchObject({ failed: 1 });
    let s = await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(s).toMatchObject({ status: "PAST_DUE", retryCount: 0, graceUntil: new Date(t0.getTime() + 7 * DAY), nextChargeAt: new Date(t0.getTime() + DAY) });

    // 하루가 안 지났으면 다시 시도하지 않는다
    expect(await renewDueSubscriptions(db, provider, { now: new Date(t0.getTime() + DAY / 2) })).toMatchObject({ failed: 0 });
    for (let i = 1; i <= 3; i++) {
      expect(await renewDueSubscriptions(db, provider, { now: new Date(t0.getTime() + i * DAY) })).toMatchObject({ failed: 1 });
    }
    s = await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(s).toMatchObject({ retryCount: 3, nextChargeAt: null });
    // 3번 다시 시도한 뒤에는 더 시도하지 않는다
    expect(await renewDueSubscriptions(db, provider, { now: new Date(t0.getTime() + 5 * DAY) })).toMatchObject({ failed: 0, charged: 0 });
    expect(await db.subscriptionPayment.count({ where: { sellerId: seller.id, status: "FAILED" } })).toBe(4);

    // 기간 끝이 지나도 유예(7일) 동안은 쓸 수 있고, 그 뒤 잠긴다
    expect(await sellerAccessFor(db, seller.id, new Date(t0.getTime() + 6 * DAY))).toBe("grace");
    expect(await sellerAccessFor(db, seller.id, new Date(t0.getTime() + 7 * DAY + 1000))).toBe("expired");
  });

  it("유예 중에 카드를 바꾸면 바로 다시 결제하고, 기간은 끊긴 데서 이어진다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, seller } = await paidShop(provider);
    await declineStored(provider, sub.id);
    const end = sub.currentPeriodEnd!;
    await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) });
    const now = new Date(end.getTime() + 2 * DAY);
    expect(await sellerAccessFor(db, seller.id, now)).toBe("grace");
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "new-card", now })).toMatchObject({ ok: true, charged: true });
    const renewed = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } });
    expect(renewed).toMatchObject({ status: "ACTIVE", currentPeriodStart: end, retryCount: 0, graceUntil: null });
  });

  it("결제한 기간 중 해지하면 기간 끝까지 쓰고, 끝나면 결제 없이 CANCELED가 되어 잠긴다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, owner } = await paidShop(provider);
    expect(await cancelSubscription(db, ctx)).toMatchObject({ ok: true, currentPeriodEnd: sub.currentPeriodEnd });
    const end = sub.currentPeriodEnd!;
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) })).toMatchObject({ charged: 0, canceled: 0 });
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) })).toMatchObject({ charged: 0, canceled: 1 });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("CANCELED");
    expect(provider.charges).toHaveLength(1);
    // 세션 만료와 섞이지 않게 기간 끝을 지금 이전으로 옮겨 확인한다
    await db.sellerSubscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    await expect(requireSeller(db, await sessionToken(owner.email))).rejects.toMatchObject({ status: 402 });
  });

  it("구독 화면은 이용 상태·가격·다음 결제·청구 내역을 보여 주고 빌링키는 내보내지 않는다", async () => {
    const provider = new FakeBillingProvider();
    const { ctx } = await paidShop(provider);
    const v = await getSubscriptionView(db, ctx);
    expect(v).toMatchObject({
      access: "paid",
      plan: { listPrice: 300000, salePrice: 199000 },
      subscription: { cardLabel: "테스트카드 1234", nextChargeAt: expect.any(Date) },
    });
    expect(v.payments).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain("billingKey");
  });
});

describe("이중 결제·결제 결과 유실 (MASTER 검수 P1)", () => {
  it("예약 실행이 하루 넘게 늦은 상태에서 카드 등록과 예약 결제가 겹쳐도 한 번만 결제된다", async () => {
    const trialEndsAt = new Date(Date.now() - 3 * DAY);
    const s = await shop(new Date(Date.now() + DAY));
    const provider = new FakeBillingProvider();
    await registerCardAndPay(db, provider, s.ctx, { authKey: "first" });
    // 체험하기가 3일 전에 끝났는데 예약 실행이 아직 안 돈 상황
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt } });
    await db.sellerSubscription.update({ where: { sellerId: s.seller.id }, data: { nextChargeAt: trialEndsAt } });
    expect(await sellerAccessFor(db, s.seller.id)).toBe("charging");

    for (let i = 0; i < 5; i++) {
      await Promise.all([registerCardAndPay(db, provider, s.ctx, { authKey: `again-${i}` }), renewDueSubscriptions(db, provider)]);
    }
    expect(await db.subscriptionPayment.count({ where: { sellerId: s.seller.id, status: "PAID" } })).toBe(1);
    expect(provider.charges).toHaveLength(1);
  });

  it("PG 응답이 끊겨 결제 결과를 못 받으면 PENDING으로 두고, 정리 함수가 같은 청구 id로 확인해 확정한다", async () => {
    const s = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    provider.failNext = "timeout_after_charge"; // PG에서는 결제됐지만 응답 유실
    expect(await registerCardAndPay(db, provider, s.ctx, { authKey: "t1" })).toEqual({ ok: false, reason: "payment_pending" });
    expect((await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: s.seller.id } })).status).toBe("PENDING");
    // 확정 전 다시 눌러도 이중 결제하지 않는다
    expect(await registerCardAndPay(db, provider, s.ctx, { authKey: "t2" })).toEqual({ ok: false, reason: "payment_in_progress" });
    expect(await reconcileStalePayments(db, provider, { staleMs: 0 })).toMatchObject({ paid: 1, recharged: 0 });
    expect(provider.charges).toHaveLength(1);
    expect(await sellerAccessFor(db, s.seller.id)).toBe("paid");
    // 다시 돌려도 바뀌지 않는다
    expect(await reconcileStalePayments(db, provider, { staleMs: 0 })).toMatchObject({ paid: 0, failed: 0 });
  });

  it("결제 요청이 PG에 닿지 않았으면(기록 없음) 같은 청구 id로 다시 요청해 확정한다", async () => {
    const s = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    provider.failNext = "timeout_before_charge";
    expect(await registerCardAndPay(db, provider, s.ctx, { authKey: "t3" })).toEqual({ ok: false, reason: "payment_pending" });
    expect(await reconcileStalePayments(db, provider, { staleMs: 0 })).toMatchObject({ paid: 1, recharged: 1 });
    const pay = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    expect(pay.status).toBe("PAID");
    expect(provider.charges).toEqual([expect.objectContaining({ orderId: pay.id })]);
  });

  it("예약 실행은 한 판매자가 실패해도 나머지를 계속 처리한다", async () => {
    const provider = new FakeBillingProvider();
    const a = await shop(new Date(Date.now() - DAY));
    const b = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, a.ctx, { authKey: "a" });
    await registerCardAndPay(db, provider, b.ctx, { authKey: "b" });
    const subA = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: a.seller.id } });
    // a의 빌링키를 다른 판매자 것으로 바꿔 풀리지 않게 만든다(AAD)
    const subB = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: b.seller.id } });
    await db.sellerSubscription.update({ where: { id: subA.id }, data: { billingKeyCipher: subB.billingKeyCipher } });
    const at = new Date(Math.max(subA.currentPeriodEnd!.getTime(), subB.currentPeriodEnd!.getTime()) - DAY / 2);
    expect(await renewDueSubscriptions(db, provider, { now: at })).toMatchObject({ charged: 1, errors: 1 });
  });
});

describe("기간은 항상 원래 결제일에 이어서 (대표님 결정)", () => {
  async function failedRenewal() {
    const provider = new FakeBillingProvider();
    const s = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, s.ctx, { authKey: "p" });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    provider.decline(openBillingKey(sub.billingKeyCipher!, s.seller.id));
    const end = sub.currentPeriodEnd!;
    await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) });
    return { s, sub, end, provider };
  }

  it("유예 중에 결제하면 지난 기간 끝부터, 다음 기준일까지", async () => {
    const { s, sub, end, provider } = await failedRenewal();
    const now = new Date(end.getTime() + 3 * DAY);
    expect(await sellerAccessFor(db, s.seller.id, now)).toBe("grace");
    expect((await registerCardAndPay(db, provider, s.ctx, { authKey: "grace", now })).ok).toBe(true);
    const after = await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after).toMatchObject({ currentPeriodStart: end, currentPeriodEnd: addMonthsKst(sub.billingAnchorAt!, 2) });
  });

  it("잠긴 뒤에 결제해도 지난 기간 끝부터(잠긴 날도 포함)", async () => {
    const { s, sub, end, provider } = await failedRenewal();
    const now = new Date(end.getTime() + 10 * DAY);
    expect(await sellerAccessFor(db, s.seller.id, now)).toBe("expired");
    expect((await registerCardAndPay(db, provider, s.ctx, { authKey: "locked", now })).ok).toBe(true);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ currentPeriodStart: end });
  });

  it("잠금이 길어 지난 기간 끝부터 세도 이미 지났으면 결제한 시각부터 새로 세고, 청구는 1회만 한다(MASTER 결정)", async () => {
    const { s, sub, end, provider } = await failedRenewal();
    const now = new Date(end.getTime() + 40 * DAY);
    const paidBefore = await db.subscriptionPayment.count({ where: { sellerId: s.seller.id, status: "PAID" } });
    const chargesBefore = provider.charges.length;
    expect((await registerCardAndPay(db, provider, s.ctx, { authKey: "late", now })).ok).toBe(true);
    expect(await db.subscriptionPayment.count({ where: { sellerId: s.seller.id, status: "PAID" } })).toBe(paidBefore + 1);
    expect(provider.charges.length).toBe(chargesBefore + 1);
    expect(provider.charges.at(-1)!.amount).toBe(199000);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ currentPeriodStart: now, billingAnchorAt: now });
    expect(await sellerAccessFor(db, s.seller.id, now)).toBe("paid");
  });

  it("유예 중 해지 예약을 하면 유예가 지워진다", async () => {
    const { s, sub, end } = await failedRenewal();
    await cancelSubscription(db, s.ctx, { now: new Date(end.getTime() + DAY) });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).graceUntil).toBeNull();
    expect(await sellerAccessFor(db, s.seller.id, new Date(end.getTime() + 2 * DAY))).toBe("expired");
  });
});

describe("구독이 끝나 잠긴 판매자의 오버레이", () => {
  const params = (token: string) => ({ params: Promise.resolve({ token }) });

  it("state·version·stream 모두 404, 열려 있던 SSE는 다음 핑 재확인 때 닫힌다", async () => {
    SSE_CONFIG.pingMs = 100;
    try {
      const { seller, ctx } = await shop(new Date(Date.now() + DAY));
      const token = await issueOverlayToken(db, { ...ctx, permissions: [] });
      const stream = await overlayStream(new Request(`http://localhost/api/overlay/${token}/stream`), params(token));
      expect(stream.status).toBe(200);

      await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
      expect((await overlayState(new Request(`http://localhost/api/overlay/${token}/state`), params(token))).status).toBe(404);
      expect((await overlayVersion(new Request(`http://localhost/api/overlay/${token}/version`), params(token))).status).toBe(404);
      expect((await overlayStream(new Request(`http://localhost/api/overlay/${token}/stream`), params(token))).status).toBe(404);

      const reader = stream.body!.getReader();
      const until = Date.now() + 5000;
      for (;;) {
        if (Date.now() > until) throw new Error("스트림이 닫히지 않음");
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      SSE_CONFIG.pingMs = 25_000;
      await liveHub().close();
    }
  });
});

describe("HTTP: 체험하기 종료 후 열리는 화면", () => {
  const BASE = "http://localhost:3000";
  const req = (path: string, init: { body?: unknown; cookie?: string } = {}) =>
    new Request(BASE + path, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE, ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

  it("주문대기는 402, 내 정보·구독 화면·카드 등록·로그아웃은 열리고, 결제 후 주문대기가 열린다", async () => {
    const { owner } = await shop(new Date(Date.now() - DAY));
    const cookie = cookieOf(await sellerLogin(req("/api/seller/auth/login", { body: { email: owner.email, password: PASSWORD } })));
    const blocked = await queueRoute(req("/api/seller/queue", { cookie }));
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({ error: "subscription_required" });

    const me = await sellerMe(req("/api/seller/me", { cookie }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ access: "expired" });
    expect((await subscriptionRoute(req("/api/seller/subscription", { cookie }))).status).toBe(200);

    const paid = await cardRoute(req("/api/seller/subscription/card", { body: { authKey: "http-card" }, cookie }));
    expect(paid.status).toBe(200);
    expect((await queueRoute(req("/api/seller/queue", { cookie }))).status).toBe(200);
    expect((await sellerLogout(req("/api/seller/auth/logout", { body: {}, cookie }))).status).toBe(200);
  });

  it("요금 안내는 로그인 없이 DB 가격을 보여 준다(신규 가입 기본 플랜 통합과 가입할 수 있는 두 플랜, STANDARD는 빠짐)", async () => {
    const res = await plansRoute();
    const integrated = { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 };
    expect(await res.json()).toEqual({
      ...integrated,
      plans: [{ code: "OVERLAY_ONLY", name: "오버레이 전용", listPrice: 99000, salePrice: 69000, trialDays: 7 }, integrated],
    });
  });

  it("마스터 승인 API: 승인하면 체험하기 종료 시각을 돌려준다(오버레이 전용은 시각, 통합은 null)", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const cookie = cookieOf(await adminLogin(req("/api/admin/auth/login", { body: adminCredentials(admin) })));
    const approve = async (planId: string) => {
      const seller = await db.seller.create({ data: { slug: `route-pending-${planId.slice(0, 8)}`, shopName: "승인 대기", planId } });
      const res = await approveRoute(req(`/api/admin/sellers/${seller.id}/approve`, { body: {}, cookie }), { params: Promise.resolve({ sellerId: seller.id }) });
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await approve(plans.OVERLAY_ONLY.id)).toMatchObject({ ok: true, trialEndsAt: expect.any(String) });
    expect(await approve(plans.INTEGRATED.id)).toMatchObject({ ok: true, trialEndsAt: null });
  });
});

describe("잠금 중 허용 범위", () => {
  it("잠긴 판매자도 이미 받은 주문은 조회·환불할 수 있고, 방송 시작(새 판매)은 402다", async () => {
    const { seller, owner } = await shop(new Date(Date.now() + DAY));
    const grade = await db.memberGrade.findFirstOrThrow({ where: { sellerId: seller.id } });
    const buyer = await createBuyer(seller.id, grade.id);
    const product = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 5 } });
    const order = await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 5000 } });
    await db.orderItem.create({
      data: { sellerId: seller.id, orderId: order.id, productId: product.id, optionId: option.id, productNameSnapshot: "팩", optionNameSnapshot: "1팩", unitPrice: 5000, quantity: 1 },
    });
    expect((await markOrderPaid(db, { sellerId: seller.id, orderId: order.id, paymentMethod: "CARD" })).ok).toBe(true);
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });

    const token = await sessionToken(owner.email);
    const headers = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie: `lo_seller=${token}` };
    const params = { params: Promise.resolve({ orderId: order.id }) };
    expect((await orderRoute(new Request(`http://localhost:3000/api/seller/orders/${order.id}`, { headers }), params)).status).toBe(200);
    const version = (await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).liveVersion;
    const refund = await refundRoute(
      new Request(`http://localhost:3000/api/seller/orders/${order.id}/refund`, { method: "POST", headers, body: JSON.stringify({ reason: "요청", expectedVersion: version, expectedRefundAmount: 5000 }) }),
      params,
    );
    expect(refund.status).toBe(200);
    const start = await broadcastStart(new Request("http://localhost:3000/api/seller/broadcast/start", { method: "POST", headers, body: "{}" }));
    expect(start.status).toBe(402);
  });
});

describe("잠금 30일 뒤 자동 해지", () => {
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  it("잠긴 지 30일이 지나면 해지 표시·구독 CANCELED·도메인 비활성, 30일 전이거나 유예 중이면 그대로", async () => {
    const closedShop = await shop(ago(31));
    const recent = await shop(ago(29));
    const grace = await shop(ago(40));
    await db.sellerSubscription.create({
      data: { sellerId: grace.seller.id, planId: (await db.subscriptionPlan.findFirstOrThrow()).id, status: "PAST_DUE", graceUntil: new Date(Date.now() + DAY) },
    });
    const pastDue = await shop(ago(60));
    await db.sellerSubscription.create({
      data: { sellerId: pastDue.seller.id, planId: (await db.subscriptionPlan.findFirstOrThrow()).id, status: "PAST_DUE", graceUntil: ago(31), currentPeriodEnd: ago(38) },
    });
    await db.sellerDomain.create({ data: { sellerId: closedShop.seller.id, hostname: "closed.example.com" } });

    const now = new Date();
    expect(await closeLongLockedSellers(db, { now })).toEqual({ closed: 2 });
    expect((await db.seller.findUniqueOrThrow({ where: { id: closedShop.seller.id } })).serviceEndedAt).toEqual(now);
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { hostname: "closed.example.com" } })).suspendedAt).toEqual(now);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: pastDue.seller.id } })).status).toBe("CANCELED");
    for (const s of [recent, grace]) expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).serviceEndedAt).toBeNull();
    // 다시 돌려도 바뀌지 않는다
    expect(await closeLongLockedSellers(db)).toEqual({ closed: 0 });
    expect(await db.auditLog.count({ where: { action: "subscription.auto_closed" } })).toBe(2);
  });

  it("보관 기간 안에 다시 구독하면 해지 표시를 지우고 해지 때 푼 도메인만 되살린다", async () => {
    const s = await shop(ago(31));
    await db.sellerDomain.create({ data: { sellerId: s.seller.id, hostname: "live.example.com" } });
    const manual = await db.sellerDomain.create({ data: { sellerId: s.seller.id, hostname: "old.example.com", suspendedAt: ago(100) } });
    await closeLongLockedSellers(db);
    expect((await registerCardAndPay(db, new FakeBillingProvider(), s.ctx, { authKey: "back" })).ok).toBe(true);
    expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).serviceEndedAt).toBeNull();
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { hostname: "live.example.com" } })).suspendedAt).toBeNull();
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { id: manual.id } })).suspendedAt).toEqual(manual.suspendedAt);
    expect(await sellerAccessFor(db, s.seller.id, new Date())).toBe("paid");
  });
});

describe("체험하기 한도", () => {
  it("체험하기 중에만 한도를 보고, 마스터가 바꾼 값이 바로 적용된다", async () => {
    const trial = await shop(new Date(Date.now() + DAY));
    expect(await checkTrialLimit(db, trial.seller.id, "message", { used: 99, adding: 1 })).toEqual({ ok: true });
    expect(await checkTrialLimit(db, trial.seller.id, "message", { used: 99, adding: 2 })).toEqual({ ok: false, reason: "trial_limit_exceeded", limit: 100 });
    expect(await checkTrialLimit(db, trial.seller.id, "identity", { used: 50, adding: 1 })).toMatchObject({ ok: false, limit: 50 });
    expect(await checkTrialLimit(db, trial.seller.id, "storageMb", { used: 1000, adding: 24 })).toEqual({ ok: true });

    const admin = await adminCtx("SUPER_ADMIN");
    expect(await updateTrialLimits(db, admin, "STANDARD", { message: 200, identity: 50, storageMb: 1024 })).toMatchObject({ ok: true });
    expect(await checkTrialLimit(db, trial.seller.id, "message", { used: 150, adding: 1 })).toEqual({ ok: true });
    expect(await updateTrialLimits(db, admin, "STANDARD", { message: -1, identity: 50, storageMb: 1024 })).toEqual({ ok: false, reason: "invalid_limit" });
    await expect(updateTrialLimits(db, await adminCtx("CS"), "STANDARD", { message: 1, identity: 1, storageMb: 1 })).rejects.toMatchObject({ status: 403 });

    // 결제한 판매자는 한도 없음
    const paid = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, new FakeBillingProvider(), paid.ctx, { authKey: "p" });
    expect(await checkTrialLimit(db, paid.seller.id, "message", { used: 10_000, adding: 1 })).toEqual({ ok: true });
  });
});

describe("MASTER 재검수 3차 재현", () => {
  async function paidShop(provider: FakeBillingProvider) {
    const s = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, s.ctx, { authKey: `k-${s.seller.id}` });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    return { ...s, sub, end: sub.currentPeriodEnd! };
  }

  it("1a: 예약 결제가 PG에 닿지 못해 PENDING인 채로 해지 예약하면, 정리 함수가 다시 결제하지 않고 청구를 닫는다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, end, seller } = await paidShop(provider);
    provider.failNext = "timeout_before_charge";
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) })).toMatchObject({ pending: 1 });
    // 진행 중 결제가 있으면 해지는 막힌다(409). 다른 경로로 해지 예약 상태가 된 경우를 직접 만들어 정리 함수를 확인한다.
    expect(await cancelSubscription(db, ctx, { now: new Date(end.getTime() - DAY / 3) })).toEqual({ ok: false, reason: "payment_in_progress" });
    await db.sellerSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, nextChargeAt: end } });
    await reconcileStalePayments(db, provider, { staleMs: 0, now: new Date(end.getTime() - DAY / 4) });
    expect(provider.charges).toHaveLength(1); // 처음 결제만
    const pending = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: seller.id, scheduled: true } });
    expect(pending).toMatchObject({ status: "FAILED", failureReason: "canceled" });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodEnd).toEqual(end);
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) })).toMatchObject({ canceled: 1, charged: 0 });
  });

  it("1b: 자동결제 재시도가 PENDING인 채로 즉시 해지하면, 정리 함수가 다시 결제하지 않고 구독은 CANCELED로 남는다", async () => {
    const declining = new FakeBillingProvider();
    const { sub, ctx, end, seller } = await paidShop(declining);
    declining.decline(openBillingKey(sub.billingKeyCipher!, seller.id));
    await renewDueSubscriptions(db, declining, { now: new Date(end.getTime() - DAY / 2) });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("PAST_DUE");

    const pg = new FakeBillingProvider();
    pg.failNext = "timeout_before_charge";
    expect(await renewDueSubscriptions(db, pg, { now: new Date(end.getTime() + DAY) })).toMatchObject({ pending: 1 });
    expect(await cancelSubscription(db, ctx, { now: new Date(end.getTime() + DAY + 1000) })).toEqual({ ok: false, reason: "payment_in_progress" });
    // 다른 경로(예: 자동 해지)로 해지된 상태를 직접 만든다
    await db.sellerSubscription.update({
      where: { id: sub.id },
      data: { status: "CANCELED", canceledAt: new Date(end.getTime() + DAY + 1000), cancelAtPeriodEnd: true, nextChargeAt: null, graceUntil: null },
    });
    await reconcileStalePayments(db, pg, { staleMs: 0, now: new Date(end.getTime() + 2 * DAY) });
    expect(pg.charges).toHaveLength(0);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: "CANCELED", currentPeriodEnd: end });
  });

  it("1b': PG가 이미 결제했는데(응답 유실) 그사이 해지됐으면, 구독은 되살리지 않고 환불 대상으로만 기록한다", async () => {
    const declining = new FakeBillingProvider();
    const { sub, ctx, end, seller } = await paidShop(declining);
    declining.decline(openBillingKey(sub.billingKeyCipher!, seller.id));
    await renewDueSubscriptions(db, declining, { now: new Date(end.getTime() - DAY / 2) });
    const pg = new FakeBillingProvider();
    pg.failNext = "timeout_after_charge";
    expect(await renewDueSubscriptions(db, pg, { now: new Date(end.getTime() + DAY) })).toMatchObject({ pending: 1 });
    expect(await cancelSubscription(db, ctx, { now: new Date(end.getTime() + DAY + 1000) })).toEqual({ ok: false, reason: "payment_in_progress" });
    await db.sellerSubscription.update({
      where: { id: sub.id },
      data: { status: "CANCELED", canceledAt: new Date(end.getTime() + DAY + 1000), cancelAtPeriodEnd: true, nextChargeAt: null, graceUntil: null },
    });
    await reconcileStalePayments(db, pg, { staleMs: 0, now: new Date(end.getTime() + 2 * DAY) });
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: "CANCELED", currentPeriodEnd: end });
    expect(await db.auditLog.count({ where: { sellerId: seller.id, action: "subscription.refund_required" } })).toBe(1);
  });

  it("2: 해지 예약 기간이 끝난 뒤 예약 실행보다 먼저 다시 구독하면, 기간은 지난 기간 끝이 아니라 결제한 시각부터다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, end } = await paidShop(provider);
    await cancelSubscription(db, ctx, { now: new Date(end.getTime() - 5 * DAY) });
    const now = new Date(end.getTime() + 2 * DAY); // 예약 실행이 아직 CANCELED로 바꾸지 않음
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ACTIVE");
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "back", now })).toMatchObject({ ok: true, charged: true });
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      currentPeriodStart: now,
      billingAnchorAt: now,
      subscribedAt: now,
      cancelAtPeriodEnd: false,
    });
  });

  it("3-1: 30일 안에 가격을 두 번 바꿔도, 첫 변경 뒤 가입한 판매자는 가입 때 가격(250,000원)을 내다가 30일 뒤 새 가격을 낸다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    const provider = new FakeBillingProvider();
    await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 250000 });
    const { sub, ctx } = await paidShop(provider);
    expect(provider.charges.at(-1)!.amount).toBe(250000);
    await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 280000 });
    const c2 = (await db.subscriptionPriceChange.findFirstOrThrow({ orderBy: { changedAt: "desc" } })).changedAt;

    // 두 번째 변경 + 10일에 다음 결제가 오게 기간 끝을 옮긴다
    const end = new Date(c2.getTime() + 10 * DAY);
    await db.sellerSubscription.update({
      where: { id: sub.id },
      data: { currentPeriodEnd: end, nextChargeAt: new Date(end.getTime() - DAY), billingAnchorAt: addMonthsKst(end, -1) },
    });
    await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) });
    expect(provider.charges.at(-1)!.amount).toBe(250000); // 199,000원으로 내려가지 않는다
    const next = await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    await renewDueSubscriptions(db, provider, { now: new Date(next.currentPeriodEnd!.getTime() - DAY / 2) });
    expect(provider.charges.at(-1)!.amount).toBe(280000);
    // 두 번째 변경 전에 가입했으므로 그 변경의 고지 대상이다
    const targets = await listPriceChangeNoticeTargets(db, admin);
    expect(targets.find((t) => t.sellerId === ctx.sellerId)).toBeDefined();
  });

  it("3-2: 가격 변경 전 구독자가 해지했다가 30일 안에 다시 구독하면 새 구독자로 보고 지금 가격을 낸다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    const provider = new FakeBillingProvider();
    const { sub, ctx } = await paidShop(provider);
    expect(provider.charges.at(-1)!.amount).toBe(199000);
    await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 250000 });
    const c = (await db.subscriptionPriceChange.findFirstOrThrow({ orderBy: { changedAt: "desc" } })).changedAt;

    // 해지 예약 → 기간 끝(변경 + 5일) → 예약 실행이 CANCELED → 변경 + 6일에 다시 구독
    await cancelSubscription(db, ctx);
    const end = new Date(c.getTime() + 5 * DAY);
    await db.sellerSubscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: end, nextChargeAt: end, billingAnchorAt: addMonthsKst(end, -1) } });
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) })).toMatchObject({ canceled: 1 });
    const now = new Date(c.getTime() + 6 * DAY);
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "again", now })).toMatchObject({ ok: true, charged: true });
    expect(provider.charges.at(-1)!.amount).toBe(250000);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ subscribedAt: now, status: "ACTIVE", canceledAt: null });
    expect(await sellerAccessFor(db, ctx.sellerId, now)).toBe("paid");
    expect(await db.auditLog.count({ where: { sellerId: ctx.sellerId, action: "subscription.refund_required" } })).toBe(0);
  });
});

describe("MASTER 재검수 4차: 해지 뒤 다시 구독하면 되살린다", () => {
  async function paidShop(provider: FakeBillingProvider) {
    const s = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, s.ctx, { authKey: `k-${s.seller.id}` });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    return { ...s, sub, end: sub.currentPeriodEnd! };
  }
  const expectRevived = async (sellerId: string, now: Date) => {
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId } });
    expect(sub).toMatchObject({ status: "ACTIVE", canceledAt: null, cancelAtPeriodEnd: false, currentPeriodStart: now });
    expect(await sellerAccessFor(db, sellerId, now)).toBe("paid");
    expect(await db.auditLog.count({ where: { sellerId, action: "subscription.refund_required" } })).toBe(0);
  };

  it("①: 해지 예약 → 예약 실행이 CANCELED → 다시 구독하면 ACTIVE·이용 가능", async () => {
    const provider = new FakeBillingProvider();
    const { ctx, end, seller } = await paidShop(provider);
    await cancelSubscription(db, ctx, { now: new Date(end.getTime() - 5 * DAY) });
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) })).toMatchObject({ canceled: 1 });
    const now = new Date(end.getTime() + 2 * DAY);
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "back", now })).toMatchObject({ ok: true, charged: true });
    expect(provider.charges).toHaveLength(2);
    await expectRevived(seller.id, now);
  });

  it("②: 유예 중 즉시 해지 → 다시 구독하면 ACTIVE·이용 가능", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, end, seller } = await paidShop(provider);
    const declining = new FakeBillingProvider();
    declining.decline(openBillingKey(sub.billingKeyCipher!, seller.id));
    await renewDueSubscriptions(db, declining, { now: new Date(end.getTime() - DAY / 2) });
    expect(await cancelSubscription(db, ctx, { now: new Date(end.getTime() + DAY) })).toMatchObject({ ok: true, currentPeriodEnd: null });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("CANCELED");
    const now = new Date(end.getTime() + 2 * DAY);
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "back", now })).toMatchObject({ ok: true, charged: true });
    await expectRevived(seller.id, now);
  });

  it("③: 구독하던 쇼핑몰이 30일 잠금으로 자동 해지된 뒤 다시 구독하면 해지 표시·도메인까지 되살린다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, end, seller } = await paidShop(provider);
    await db.sellerDomain.create({ data: { sellerId: seller.id, hostname: "revive.example.com" } });
    await cancelSubscription(db, ctx, { now: new Date(end.getTime() - 5 * DAY) });
    await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) });
    const closeAt = new Date(end.getTime() + 31 * DAY);
    expect(await closeLongLockedSellers(db, { now: closeAt })).toEqual({ closed: 1 });
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).serviceEndedAt).toEqual(closeAt);
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { hostname: "revive.example.com" } })).suspendedAt).toEqual(closeAt);

    const now = new Date(closeAt.getTime() + DAY);
    expect(await registerCardAndPay(db, provider, ctx, { authKey: "back", now })).toMatchObject({ ok: true, charged: true });
    await expectRevived(seller.id, now);
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).serviceEndedAt).toBeNull();
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { hostname: "revive.example.com" } })).suspendedAt).toBeNull();
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).subscribedAt).toEqual(now);
  });

  it("해지 뒤 다시 구독했지만 결제가 실패하면 CANCELED·잠김 그대로", async () => {
    const provider = new FakeBillingProvider();
    const { ctx, end, seller } = await paidShop(provider);
    await cancelSubscription(db, ctx, { now: new Date(end.getTime() - 5 * DAY) });
    await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) });
    const declining = new (class extends FakeBillingProvider {
      async charge() {
        return { ok: false as const, reason: "card_declined" };
      }
    })();
    const now = new Date(end.getTime() + 2 * DAY);
    expect(await registerCardAndPay(db, declining, ctx, { authKey: "bad", now })).toEqual({ ok: false, reason: "payment_failed" });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } })).status).toBe("CANCELED");
    expect(await sellerAccessFor(db, seller.id, now)).toBe("expired");
  });
});

describe("#67 재검수 P2: 결제를 처리하는 중의 해지", () => {
  it("카드 등록 결제가 진행 중이면 해지는 409(payment_in_progress)이고, 등록 응답은 실제 구독 상태대로 성공이다", async () => {
    const s = await shop(new Date(Date.now() - DAY));
    let release!: () => void;
    let entered!: () => void;
    const inCharge = new Promise<void>((r) => (entered = r));
    const slow = new (class extends FakeBillingProvider {
      async charge(input: Parameters<FakeBillingProvider["charge"]>[0]) {
        entered();
        await new Promise<void>((r) => (release = r));
        return super.charge(input);
      }
    })();
    const registering = registerCardAndPay(db, slow, s.ctx, { authKey: "slow" });
    await inCharge;
    expect(await cancelSubscription(db, s.ctx)).toEqual({ ok: false, reason: "payment_in_progress" });
    release();
    expect(await registering).toMatchObject({ ok: true, charged: true });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    expect(sub).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: false });
    expect(await sellerAccessFor(db, s.seller.id)).toBe("paid");
  });

  it("해지 API: 진행 중 결제가 있으면 409와 안내 문구", async () => {
    const s = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    provider.failNext = "timeout_before_charge";
    await registerCardAndPay(db, provider, s.ctx, { authKey: "p" });
    const token = await sessionToken(s.owner.email);
    const res = await cancelRoute(
      new Request("http://localhost:3000/api/seller/subscription/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie: `lo_seller=${token}` },
        body: "{}",
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "payment_in_progress", message: "결제를 처리하고 있습니다. 잠시 뒤 다시 시도해 주십시오" });
  });
});
