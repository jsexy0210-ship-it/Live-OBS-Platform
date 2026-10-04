import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as endRoute } from "../../app/api/seller/broadcast/end/route";
import { POST as startRoute } from "../../app/api/seller/broadcast/start/route";
import { POST as deliverRoute } from "../../app/api/seller/orders/[orderId]/deliver/route";
import { GET as meRoute } from "../../app/api/seller/me/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// /api/seller/me의 orderFollowup(후속 처리 대상이 남았는지): 플랜이 STORE_OPERATIONS를 주지 않아도(오버레이 전용으로 내린 뒤)
// 끝나지 않은 주문이나 유효한 구매 제한이 있으면 true, 다 끝나면 false. 판정은 lib/server/orders/followup.ts 한 곳이다.
// 방송 종료 API 보강(broadcastSessionId)도 함께 시험한다.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const DAY = 86_400_000;

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

// 오버레이 전용으로 내려간 쇼핑몰(기능 권한은 OVERLAY·EXTERNAL_INTEGRATION)
async function downgradedShop() {
  const { seller, grade } = await createSeller();
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
  await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * DAY), nextChargeAt: new Date(Date.now() + 19 * DAY) } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await createBuyer(seller.id, grade.id);
  let n = 0;
  const order = (status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED", extra: Record<string, unknown> = {}) =>
    db.order.create({ data: { sellerId: seller.id, orderNo: ++n, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status, paidAt: status === "PENDING_PAYMENT" ? null : new Date(), ...extra } });
  return { seller, grade, buyer, order, cookie: await cookieOf(owner.email) };
}
const me = async (cookie: string) => {
  const r = await meRoute(new Request("http://localhost:3000/api/seller/me", { headers: { host: H.host, cookie } }));
  return (await r.json()) as { features: string[]; orderFollowup: boolean };
};

describe("/api/seller/me orderFollowup", () => {
  it("내린 직후 끝나지 않은 주문이 있으면 true, 남은 주문을 모두 마치면 false(STORE_OPERATIONS는 계속 없음)", async () => {
    const s = await downgradedShop();
    expect(await me(s.cookie)).toMatchObject({ features: ["OVERLAY", "EXTERNAL_INTEGRATION"], orderFollowup: false });
    // 결제 대기 주문 하나만으로도 true(입금 확인·취소 처리가 남음), 취소하면 다시 false
    const pending = await s.order("PENDING_PAYMENT");
    expect((await me(s.cookie)).orderFollowup).toBe(true);
    await db.order.update({ where: { id: pending.id }, data: { status: "CANCELLED" } });
    expect((await me(s.cookie)).orderFollowup).toBe(false);
    await db.order.update({ where: { id: pending.id }, data: { status: "PENDING_PAYMENT" } });
    const unshipped = await s.order("PAID");
    const transit = await s.order("PAID");
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: transit.id, courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT", shippedAt: new Date() } });
    expect((await me(s.cookie)).orderFollowup).toBe(true);

    // 결제 대기 → 취소, 발송 전 → 환불, 배송 중 → 배송 완료로 하나씩 마친다. 마지막 하나가 끝나야 false.
    await db.order.update({ where: { id: pending.id }, data: { status: "CANCELLED" } });
    expect((await me(s.cookie)).orderFollowup).toBe(true);
    await db.order.update({ where: { id: unshipped.id }, data: { status: "REFUNDED" } });
    expect((await me(s.cookie)).orderFollowup).toBe(true);
    const done = await deliverRoute(new Request(`http://localhost:3000/api/seller/orders/${transit.id}/deliver`, { method: "POST", headers: { ...H, cookie: s.cookie } }), {
      params: Promise.resolve({ orderId: transit.id }),
    });
    expect(done.status).toBe(200);
    expect(await me(s.cookie)).toMatchObject({ features: ["OVERLAY", "EXTERNAL_INTEGRATION"], orderFollowup: false });
  });

  it("마지막 주문을 끝내도 유효한 구매 제한이 남아 있으면 true, 풀거나 기간이 끝나면 false", async () => {
    const s = await downgradedShop();
    const r = (data: Record<string, unknown>) =>
      db.buyerPurchaseRestriction.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 29 * DAY), ...data } });
    await s.order("REFUNDED");
    expect((await me(s.cookie)).orderFollowup).toBe(false);
    const active = await r({});
    expect((await me(s.cookie)).orderFollowup).toBe(true);
    await db.buyerPurchaseRestriction.update({ where: { id: active.id }, data: { liftedAt: new Date() } });
    expect((await me(s.cookie)).orderFollowup).toBe(false);
    await r({ endsAt: new Date(Date.now() - 1000) });
    expect((await me(s.cookie)).orderFollowup).toBe(false);
    await r({});
    expect((await me(s.cookie)).orderFollowup).toBe(true);
  });

  it("다른 쇼핑몰의 주문·제한과 법정 보관 분리 주문은 세지 않는다. 배송 완료·취소·환불 주문만 있으면 false", async () => {
    const a = await downgradedShop();
    const b = await downgradedShop();
    await b.order("PAID");
    await db.buyerPurchaseRestriction.create({ data: { sellerId: b.seller.id, buyerMemberId: b.buyer.id, reason: "x", startsAt: new Date(), endsAt: new Date(Date.now() + DAY) } });
    await a.order("PAID", { legalHoldAt: new Date() });
    const done = await a.order("PAID");
    await db.shipment.create({ data: { sellerId: a.seller.id, orderId: done.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(), deliveredAt: new Date() } });
    await a.order("CANCELLED");
    await a.order("REFUNDED");
    expect((await me(a.cookie)).orderFollowup).toBe(false);
    expect((await me(b.cookie)).orderFollowup).toBe(true);
  });

  it("기능 권한이 하나도 없어 후속 처리 경로가 막혀 있으면(통합 첫 결제 전) 주문이 있어도 false", async () => {
    const { seller, grade } = await createSeller();
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: null } });
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
    const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, status: "ACTIVE", nextChargeAt: new Date(Date.now() - 60_000) } });
    await db.subscriptionPayment.create({ data: { sellerId: seller.id, subscriptionId: sub.id, amount: 179_000, status: "PENDING", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY) } });
    const buyer = await createBuyer(seller.id, grade.id);
    await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status: "PAID", paidAt: new Date() } });
    const cookie = await cookieOf((await createSellerUser(seller.id, "OWNER")).email);
    expect(await me(cookie)).toMatchObject({ features: [], orderFollowup: false });
  });
});

describe("방송 종료 broadcastSessionId", () => {
  async function liveShop() {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const cookie = await cookieOf(owner.email);
    const post = (route: typeof startRoute, path: string, body?: unknown) => route(new Request(`http://localhost:3000/api/seller/broadcast/${path}`, { method: "POST", headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { seller, post: (path: "start" | "end", body?: unknown) => post(path === "start" ? startRoute : endRoute, path, body) };
  }

  it("A 확인 → A 종료 → B 시작 → A ID로 종료 요청은 409 not_live이고 B는 계속 LIVE", async () => {
    const s = await liveShop();
    const a = (await (await s.post("start")).json()) as { broadcastSessionId: string };
    expect((await s.post("end", { broadcastSessionId: a.broadcastSessionId })).status).toBe(200);
    const b = (await (await s.post("start")).json()) as { broadcastSessionId: string };
    const stale = await s.post("end", { broadcastSessionId: a.broadcastSessionId });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "not_live" });
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: b.broadcastSessionId } })).status).toBe("LIVE");
    // 맞는 ID로는 종료된다
    expect((await s.post("end", { broadcastSessionId: b.broadcastSessionId })).status).toBe(200);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: b.broadcastSessionId } })).status).toBe("ENDED");
  });

  it("ID를 주지 않으면 지금 LIVE 방송을 끝낸다(기존 동작). 형식이 틀린 ID는 400이고 방송은 그대로", async () => {
    const s = await liveShop();
    const a = (await (await s.post("start")).json()) as { broadcastSessionId: string };
    for (const bad of ["x", 1, null, ""]) expect((await s.post("end", { broadcastSessionId: bad })).status, String(bad)).toBe(400);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: a.broadcastSessionId } })).status).toBe("LIVE");
    expect((await s.post("end")).status).toBe(200);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: a.broadcastSessionId } })).status).toBe("ENDED");
    // 방송 중이 아니면 ID와 상관없이 409 not_live
    expect((await s.post("end", { broadcastSessionId: a.broadcastSessionId })).status).toBe(409);
  });
});
