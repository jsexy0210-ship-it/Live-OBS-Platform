import type { TenantContext } from "../../lib/server/tenant/context";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loginSeller } from "../../lib/server/auth/login";
import { resolveAdminSession, createAdminSession } from "../../lib/server/auth/session";
import { requireSeller } from "../../lib/server/authz/guards";
import { updatePlanPrice } from "../../lib/server/billing/plans";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { cancelSubscription, getSubscriptionView, registerCardAndPay, renewDueSubscriptions } from "../../lib/server/billing/subscription";
import { approveSeller } from "../../lib/server/sellers/approval";
import { POST as approveRoute } from "../../app/api/admin/sellers/[sellerId]/approve/route";
import { GET as plansRoute } from "../../app/api/plans/route";
import { POST as sellerLogin } from "../../app/api/seller/auth/login/route";
import { POST as sellerLogout } from "../../app/api/seller/auth/logout/route";
import { GET as sellerMe } from "../../app/api/seller/me/route";
import { GET as queueRoute } from "../../app/api/seller/queue/route";
import { GET as subscriptionRoute } from "../../app/api/seller/subscription/route";
import { POST as cardRoute } from "../../app/api/seller/subscription/card/route";
import { POST as adminLogin } from "../../app/api/admin/auth/login/route";
import { prisma } from "../../lib/server/db";
import { PASSWORD, adminCredentials, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(async () => {
  await resetDb();
  await db.subscriptionPlan.create({ data: { code: "STANDARD", name: "월 구독", listPrice: 300000, salePrice: 199000 } });
});
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

// 무료 이용 종료 시각을 정한 쇼핑몰과 대표자
async function shop(trialEndsAt: Date | null) {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt } });
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner, ctx: ownerCtx(seller.id, owner.id) };
}

async function sessionToken(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return r.token;
}

describe("판매자 승인과 무료 이용", () => {
  it("승인하면 ACTIVE가 되고 무료 이용 종료 = 승인 시각 + 3일(DB 시계), 다시 승인할 수 없다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    const seller = await db.seller.create({ data: { slug: "pending-shop", shopName: "대기 쇼핑몰" } });
    const r = await approveSeller(db, admin, seller.id);
    expect(r.ok).toBe(true);
    const saved = await db.seller.findUniqueOrThrow({ where: { id: seller.id } });
    expect(saved.status).toBe("ACTIVE");
    expect(saved.trialEndsAt!.getTime() - saved.approvedAt!.getTime()).toBe(3 * DAY);
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

  it("무료 이용 중에는 쓸 수 있고, 끝나면 판매자 API가 402로 막힌다(구독 화면만 열림)", async () => {
    const a = await shop(new Date(Date.now() + DAY));
    await expect(requireSeller(db, await sessionToken(a.owner.email))).resolves.toMatchObject({ sellerId: a.seller.id });

    const b = await shop(new Date(Date.now() - 1000));
    const token = await sessionToken(b.owner.email);
    await expect(requireSeller(db, token)).rejects.toMatchObject({ status: 402, code: "subscription_required" });
    await expect(requireSeller(db, token, new Date(), { allowUnpaid: true })).resolves.toMatchObject({ sellerId: b.seller.id });

    // 무료 이용 종료 값이 없으면(승인 기록 없음) 막는다
    const c = await shop(null);
    await expect(requireSeller(db, await sessionToken(c.owner.email))).rejects.toMatchObject({ status: 402 });
  });
});

describe("카드 등록·결제", () => {
  it("무료 이용 중에 결제하면 판매가 199,000원을 한 번 결제하고, 남은 무료 기간 뒤부터 한 달이 시작된다", async () => {
    const trialEndsAt = new Date(Date.now() + 2 * DAY);
    const { seller, ctx } = await shop(trialEndsAt);
    const provider = new FakeBillingProvider();
    const r = await registerCardAndPay(db, provider, ctx, { authKey: "auth-1" });
    expect(r).toMatchObject({ ok: true, charged: true });
    expect(provider.charges).toEqual([expect.objectContaining({ amount: 199000 })]);
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } });
    expect(sub.currentPeriodStart).toEqual(trialEndsAt);
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(trialEndsAt.getTime() + 27 * DAY);
    const pay = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: seller.id } });
    expect(pay).toMatchObject({ status: "PAID", amount: 199000 });
    // 빌링키 원문은 저장하지 않는다
    expect(JSON.stringify(sub)).not.toContain("fake-bk-");
  });

  it("무료 이용이 끝나 막힌 뒤 결제하면 바로 다시 쓸 수 있다", async () => {
    const { owner, ctx } = await shop(new Date(Date.now() - DAY));
    const token = await sessionToken(owner.email);
    await expect(requireSeller(db, token)).rejects.toMatchObject({ status: 402 });
    expect((await registerCardAndPay(db, new FakeBillingProvider(), ctx, { authKey: "auth-2" })).ok).toBe(true);
    await expect(requireSeller(db, token)).resolves.toMatchObject({ isOwner: true });
  });

  it("카드가 거절되거나 결제가 실패하면 막힌 상태 그대로고, 실패한 청구가 남는다", async () => {
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
    const impersonation: TenantContext = { ...ownerCtx(seller.id, "00000000-0000-0000-0000-000000000000"), actorType: "PLATFORM_ADMIN", isOwner: false, readOnly: true };
    await expect(registerCardAndPay(db, provider, impersonation, { authKey: "s" })).rejects.toMatchObject({ status: 403 });
    expect(provider.charges).toHaveLength(0);
  });
});

describe("가격", () => {
  it("마스터가 가격을 바꾸면 다음 결제부터 새 판매가로 청구한다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    expect(await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 249000 })).toMatchObject({ ok: true });
    const { ctx } = await shop(new Date(Date.now() - DAY));
    const provider = new FakeBillingProvider();
    await registerCardAndPay(db, provider, ctx, { authKey: "p" });
    expect(provider.charges[0].amount).toBe(249000);
    expect(await db.auditLog.count({ where: { action: "admin.plan.price_update" } })).toBe(1);
  });

  it("판매가가 정가보다 크거나 정수가 아니면 거부, CS 역할은 바꿀 수 없다", async () => {
    const admin = await adminCtx("SUPER_ADMIN");
    expect(await updatePlanPrice(db, admin, "STANDARD", { listPrice: 100000, salePrice: 199000 })).toEqual({ ok: false, reason: "invalid_price" });
    expect(await updatePlanPrice(db, admin, "STANDARD", { listPrice: 300000, salePrice: 1.5 })).toEqual({ ok: false, reason: "invalid_price" });
    await expect(updatePlanPrice(db, await adminCtx("CS"), "STANDARD", { listPrice: 1, salePrice: 1 })).rejects.toMatchObject({ status: 403 });
    expect((await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } })).salePrice).toBe(199000);
  });
});

describe("자동결제·해지", () => {
  async function paidShop(provider: FakeBillingProvider) {
    const s = await shop(new Date(Date.now() - DAY));
    await registerCardAndPay(db, provider, s.ctx, { authKey: `k-${s.seller.id}` });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    return { ...s, sub };
  }

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
    const after = await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.currentPeriodStart).toEqual(end);
  });

  it("자동결제가 실패하면 PAST_DUE, 기간이 끝나면 막히고, 카드를 다시 등록하면 이어서 결제된다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, seller } = await paidShop(provider);
    const end = sub.currentPeriodEnd!;
    const stored = await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    const { openBillingKey } = await import("../../lib/server/billing/secret");
    provider.decline(openBillingKey(stored.billingKeyCipher!));
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) })).toMatchObject({ failed: 1 });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("PAST_DUE");

    // 기간이 남아 있어도 PAST_DUE면 카드 재등록 때 다음 기간(기존 기간 끝부터)을 바로 결제한다
    const r = await registerCardAndPay(db, provider, ctx, { authKey: "new-card", now: new Date(end.getTime() - DAY / 4) });
    expect(r).toMatchObject({ ok: true, charged: true });
    const renewed = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } });
    expect(renewed).toMatchObject({ status: "ACTIVE", currentPeriodStart: end });
  });

  it("해지하면 기간 끝까지 쓰고, 끝나면 결제 없이 CANCELED가 되어 막힌다", async () => {
    const provider = new FakeBillingProvider();
    const { sub, ctx, owner } = await paidShop(provider);
    expect(await cancelSubscription(db, ctx)).toMatchObject({ ok: true });
    const end = sub.currentPeriodEnd!;
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() - DAY / 2) })).toMatchObject({ charged: 0, canceled: 0 });
    expect(await renewDueSubscriptions(db, provider, { now: new Date(end.getTime() + 1000) })).toMatchObject({ charged: 0, canceled: 1 });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("CANCELED");
    expect(provider.charges).toHaveLength(1);
    // 세션 만료와 섞이지 않게 기간 끝을 지금 이전으로 옮겨 확인한다
    await db.sellerSubscription.update({ where: { id: sub.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    await expect(requireSeller(db, await sessionToken(owner.email))).rejects.toMatchObject({ status: 402 });
  });

  it("구독 화면은 이용 상태·가격·청구 내역을 보여 준다", async () => {
    const provider = new FakeBillingProvider();
    const { ctx } = await paidShop(provider);
    const v = await getSubscriptionView(db, ctx);
    expect(v).toMatchObject({ access: "paid", plan: { listPrice: 300000, salePrice: 199000 }, subscription: { cardLabel: "테스트카드 1234" } });
    expect(v.payments).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain("billingKey");
  });
});

describe("HTTP: 무료 이용 종료 후 열리는 화면", () => {
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

  it("요금 안내는 로그인 없이 DB 가격을 보여 준다", async () => {
    const res = await plansRoute();
    expect(await res.json()).toEqual({ code: "STANDARD", name: "월 구독", listPrice: 300000, salePrice: 199000 });
  });

  it("마스터 승인 API: 승인하면 무료 이용 종료 시각을 돌려준다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const cookie = cookieOf(await adminLogin(req("/api/admin/auth/login", { body: adminCredentials(admin) })));
    const seller = await db.seller.create({ data: { slug: "route-pending", shopName: "승인 대기" } });
    const res = await approveRoute(req(`/api/admin/sellers/${seller.id}/approve`, { body: {}, cookie }), {
      params: Promise.resolve({ sellerId: seller.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, trialEndsAt: expect.any(String) });
  });
});
