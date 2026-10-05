import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as suspendRoute } from "../../app/api/admin/sellers/[sellerId]/suspend/route";
import { POST as unsuspendRoute } from "../../app/api/admin/sellers/[sellerId]/unsuspend/route";
import { POST as broadcastStart } from "../../app/api/seller/broadcast/start/route";
import { GET as meRoute } from "../../app/api/seller/me/route";
import { POST as refundRoute } from "../../app/api/seller/orders/[orderId]/refund/route";
import { POST as shipRoute } from "../../app/api/seller/orders/[orderId]/ship/route";
import { GET as ordersRoute } from "../../app/api/seller/orders/route";
import { POST as cardRoute } from "../../app/api/seller/subscription/card/route";
import { GET as subscriptionRoute } from "../../app/api/seller/subscription/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { hashToken } from "../../lib/server/auth/token";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { renewDueSubscriptions } from "../../lib/server/billing/subscription";
import { shopOpen } from "../../lib/server/buyers/signup";
import { createOrder } from "../../lib/server/orders/create";
import { resolveOverlayToken } from "../../lib/server/overlay/token";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 이용 정지 = 「신규만 막기」(대표님 결정 2026-10-04): 새 주문·방송·오버레이·결제는 막고, 이미 받은 주문의 배송·환불은 계속, 자동결제는 멈춤
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
});
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const req = (path: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost:3000${path}`, body === undefined ? { headers: { ...H, cookie } } : { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) });

async function suspendedShop() {
  const plans = await seedPlans();
  const { seller, grade } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { planId: plans.INTEGRATED.id } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!login.ok) throw new Error(login.reason);
  const buyer = await createBuyer(seller.id, grade.id);
  const toShip = await createPaidOrderItem(seller.id, buyer.id);
  await db.orderItem.updateMany({ where: { orderId: toShip.order.id }, data: { stockDeductedAt: new Date() } });
  await db.orderShippingAddress.create({ data: { sellerId: seller.id, orderId: toShip.order.id, recipientName: "김받음", phone: "01000000000", zipCode: "00000", address1: "주소" } });
  const toRefund = await createPaidOrderItem(seller.id, buyer.id);
  const admin = await createAdmin("OPERATIONS");
  const adminCookie = `lo_admin=${(await createAdminSession(db, admin.id, {})).token}`;
  const suspend = () =>
    suspendRoute(req(`/api/admin/sellers/${seller.id}/suspend`, adminCookie, { reason: "약관 위반" }), { params: Promise.resolve({ sellerId: seller.id }) });
  const unsuspend = () => unsuspendRoute(req(`/api/admin/sellers/${seller.id}/unsuspend`, adminCookie, {}), { params: Promise.resolve({ sellerId: seller.id }) });
  return { plans, seller, grade, buyer, cookie: `lo_seller=${login.token}`, toShip, toRefund, suspend, unsuspend };
}

describe("이용 정지 중 「신규만 막기」", () => {
  it("구매자 새 주문·가입은 shop_unavailable, 오버레이 공개 주소는 막힌다. 해제하면 다시 열린다", async () => {
    const s = await suspendedShop();
    const token = "ov-" + s.seller.id;
    await db.overlayToken.create({ data: { sellerId: s.seller.id, tokenHash: hashToken(token) } });
    expect(await shopOpen(db, s.seller.id)).toBe(true);
    expect(await resolveOverlayToken(db, token)).not.toBeNull();
    expect((await s.suspend()).status).toBe(200);
    expect(await shopOpen(db, s.seller.id)).toBe(false);
    expect(await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [], consent: { agreed: true, noticeVersion: "x" } } as never)).toEqual({
      ok: false,
      reason: "shop_unavailable",
    });
    expect(await resolveOverlayToken(db, token)).toBeNull();
    expect((await s.unsuspend()).status).toBe(200);
    expect(await shopOpen(db, s.seller.id)).toBe(true);
  });

  it("파트너스: 이미 받은 주문 조회·발송·환불과 내 정보·구독 조회는 되고, 방송 시작·카드 등록(결제)은 403 seller_suspended", async () => {
    const s = await suspendedShop();
    expect((await s.suspend()).status).toBe(200);
    expect((await ordersRoute(req("/api/seller/orders", s.cookie))).status).toBe(200);
    const me = await meRoute(req("/api/seller/me", s.cookie));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ suspended: true });
    expect((await subscriptionRoute(req("/api/seller/subscription", s.cookie))).status).toBe(200);

    const shipped = await shipRoute(req(`/api/seller/orders/${s.toShip.order.id}/ship`, s.cookie, { courier: "CJ", trackingNumber: "123456789012" }), {
      params: Promise.resolve({ orderId: s.toShip.order.id }),
    });
    expect(shipped.status).toBe(200);
    expect((await db.shipment.findUniqueOrThrow({ where: { orderId: s.toShip.order.id } })).status).toBe("IN_TRANSIT");

    const lv = (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    const refunded = await refundRoute(req(`/api/seller/orders/${s.toRefund.order.id}/refund`, s.cookie, { reason: "정지 중 환불", expectedVersion: lv, expectedRefundAmount: 5000 }), {
      params: Promise.resolve({ orderId: s.toRefund.order.id }),
    });
    expect(refunded.status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: s.toRefund.order.id } })).status).toBe("REFUNDED");

    const started = await broadcastStart(req("/api/seller/broadcast/start", s.cookie, { title: "방송" }));
    expect(started.status).toBe(403);
    expect(await started.json()).toMatchObject({ error: "seller_suspended" });
    expect(await db.broadcastSession.count({ where: { sellerId: s.seller.id } })).toBe(0);
    const card = await cardRoute(req("/api/seller/subscription/card", s.cookie, { authKey: "x" }));
    expect(card.status).toBe(403);
    expect(await db.subscriptionPayment.count({ where: { sellerId: s.seller.id } })).toBe(0);

    // 해제하면 방송을 다시 시작할 수 있다
    expect((await s.unsuspend()).status).toBe(200);
    expect((await broadcastStart(req("/api/seller/broadcast/start", s.cookie, { title: "방송" }))).status).toBe(200);
  });

  it("정지 중에는 구독 자동결제 대상에서 빠지고(결제 0건), 해제하면 다음 실행에서 결제한다", async () => {
    const s = await suspendedShop();
    const now = new Date();
    await db.sellerSubscription.create({
      data: {
        sellerId: s.seller.id,
        planId: s.plans.INTEGRATED.id,
        status: "ACTIVE",
        billingKeyCipher: sealBillingKey("bk-" + s.seller.id, s.seller.id),
        cardLabel: "카드",
        subscribedAt: new Date(now.getTime() - 40 * 86400_000),
        currentPeriodStart: new Date(now.getTime() - 31 * 86400_000),
        currentPeriodEnd: new Date(now.getTime() - 3600_000),
        billingAnchorAt: new Date(now.getTime() - 31 * 86400_000),
        nextChargeAt: new Date(now.getTime() - 3600_000),
      },
    });
    expect((await s.suspend()).status).toBe(200);
    await renewDueSubscriptions(db, new FakeBillingProvider());
    expect(await db.subscriptionPayment.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await s.unsuspend()).status).toBe(200);
    await renewDueSubscriptions(db, new FakeBillingProvider());
    expect(await db.subscriptionPayment.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id }, select: { status: true } })).toEqual([{ status: "PAID" }]);
  });
});
