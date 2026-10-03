import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as policyGet, PUT as policyPut } from "../../app/api/seller/order-policy/route";
import { POST as liftRoute } from "../../app/api/seller/purchase-restrictions/[buyerMemberId]/lift/route";
import { GET as restrictionsRoute } from "../../app/api/seller/purchase-restrictions/route";
import { GET as detailRoute } from "../../app/api/shop/[slug]/orders/[orderId]/route";
import { GET as listRoute, POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder, ORDER_RATE_LIMIT } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES, ORDER_NOTICES, purchaseRestrictedMessage } from "../../lib/server/orders/messages";
import { cancelOverdueOrders, liftRestriction, listPaymentDueSoon } from "../../lib/server/orders/overdue";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const HOUR = 60 * 60 * 1000;

async function shop(stock = 100) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock } });
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const place = (buyerMemberId = buyer.id) =>
    createOrder(db, { sellerId: seller.id, buyerMemberId, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
  const order = async (buyerMemberId = buyer.id) => {
    const r = await place(buyerMemberId);
    if (!r.ok) throw new Error(r.reason);
    return r.orderId;
  };
  return { seller, grade, owner, ctx, option, buyer, place, order };
}

// 입금 기한을 지난 것으로 만든다(시간 이동 대신 기한 값을 앞당김). 횟수 제한 창(1분)에도 걸리지 않게 주문 시각도 옮긴다.
const makeOverdue = (orderId: string) =>
  db.order.update({ where: { id: orderId }, data: { paymentDueAt: new Date(Date.now() - HOUR), createdAt: new Date(Date.now() - 2 * 24 * HOUR) } });

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function buyerCookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

describe("입금 기한", () => {
  it("주문 시각 + 10일(기본), 판매자가 바꾸면 다음 주문부터 그 시간으로 정하고 이미 만든 주문은 그대로", async () => {
    const s = await shop();
    const a = await db.order.findUniqueOrThrow({ where: { id: await s.order() } });
    expect(a.paymentDueAt!.getTime() - a.createdAt.getTime()).toBe(240 * HOUR);
    const c = await sellerCookie(s.owner.email);
    const put = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ autoCancelEnabled: true, paymentDueHours: 2, unpaidRestrictionEnabled: true }) }));
    expect(put.status).toBe(200);
    const b = await db.order.findUniqueOrThrow({ where: { id: await s.order() } });
    expect(b.paymentDueAt!.getTime() - b.createdAt.getTime()).toBe(2 * HOUR);
    expect((await db.order.findUniqueOrThrow({ where: { id: a.id } })).paymentDueAt).toEqual(a.paymentDueAt);
    expect(await db.auditLog.count({ where: { action: "order_policy.update" } })).toBe(1);
  });

  it("자동 취소를 「사용 안 함」으로 끄면 새 주문에 기한이 없어 자동 취소되지 않고, 끄기 전 주문은 기한대로 취소된다", async () => {
    const s = await shop();
    const before = await s.order();
    const c = await sellerCookie(s.owner.email);
    const put = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ autoCancelEnabled: false, paymentDueHours: 240, unpaidRestrictionEnabled: true }) }));
    expect(put.status).toBe(200);
    const after = await s.order();
    expect(await db.order.findUniqueOrThrow({ where: { id: after } })).toMatchObject({ paymentDueAt: null });
    await db.order.updateMany({ where: { id: { in: [before, after] } }, data: { createdAt: new Date(Date.now() - 40 * 24 * HOUR) } });
    await db.order.update({ where: { id: before }, data: { paymentDueAt: new Date(Date.now() - HOUR) } });
    expect((await cancelOverdueOrders(db)).cancelled).toEqual([before]);
    expect(await db.order.findUniqueOrThrow({ where: { id: after } })).toMatchObject({ status: "PENDING_PAYMENT" });
    expect((await listPaymentDueSoon(db)).map((o) => o.id)).not.toContain(after);
  });

  it("주문 정책 API: 기본값 조회(사용·240시간), 1시간~30일(720시간) 정수·켜고 끄기 값만 받고, 쇼핑몰 설정 권한 없는 직원은 403", async () => {
    const s = await shop();
    const c = await sellerCookie(s.owner.email);
    const got = await (await policyGet(new Request("http://localhost:3000/api/seller/order-policy", { headers: { ...H, cookie: c } }))).json();
    expect(got.policy).toEqual({ autoCancelEnabled: true, paymentDueHours: 240, unpaidRestrictionEnabled: true, restockOnCancel: true });
    const ok = { autoCancelEnabled: true, paymentDueHours: 240, unpaidRestrictionEnabled: true };
    for (const body of [
      { ...ok, paymentDueHours: 0 },
      { ...ok, paymentDueHours: 721 },
      { ...ok, paymentDueHours: 1.5 },
      { ...ok, paymentDueHours: "24" },
      { autoCancelEnabled: true, paymentDueHours: 24 },
      { paymentDueHours: 24, unpaidRestrictionEnabled: true },
      { ...ok, autoCancelEnabled: "false" },
    ]) {
      const r = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify(body) }));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_order_policy", message: ORDER_ERROR_MESSAGES.invalid_order_policy });
    }
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const r = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: await sellerCookie(staff.email) }, body: JSON.stringify({ ...ok, paymentDueHours: 2 }) }));
    expect(r.status).toBe(403);
    expect(await db.sellerOrderPolicy.count()).toBe(0);
    for (const h of [1, 720]) {
      const res = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ ...ok, paymentDueHours: h }) }));
      expect(res.status, String(h)).toBe(200);
    }
  });
});

describe("미입금 자동 취소", () => {
  it("기한이 지난 결제 대기 주문만 취소(시스템 이력·감사 로그), 기한 전·결제 완료 주문은 그대로, 재고 변화 없음, 다시 돌려도 같은 결과", async () => {
    const s = await shop(10);
    const overdue = await s.order();
    const notYet = await s.order();
    const paid = await s.order();
    await makeOverdue(overdue);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: paid, paymentMethod: "BANK_TRANSFER" });
    await db.order.update({ where: { id: paid }, data: { paymentDueAt: new Date(Date.now() - HOUR) } });
    const stockBefore = (await db.productOption.findUniqueOrThrow({ where: { id: s.option.id } })).stock;

    expect(await cancelOverdueOrders(db)).toEqual({ cancelled: [overdue], restricted: [] });
    expect(await db.order.findUniqueOrThrow({ where: { id: overdue } })).toMatchObject({ status: "CANCELLED", cancelledAt: expect.any(Date), autoCancelledAt: expect.any(Date) });
    expect(await db.order.findUniqueOrThrow({ where: { id: notYet } })).toMatchObject({ status: "PENDING_PAYMENT", autoCancelledAt: null });
    expect(await db.order.findUniqueOrThrow({ where: { id: paid } })).toMatchObject({ status: "PAID", autoCancelledAt: null });
    expect(await db.orderStatusHistory.findFirstOrThrow({ where: { orderId: overdue, toStatus: "CANCELLED" } })).toMatchObject({ actorType: "SYSTEM", reason: "payment_overdue" });
    expect(await db.auditLog.count({ where: { action: "order.auto_cancel", targetId: overdue } })).toBe(1);
    expect((await db.productOption.findUniqueOrThrow({ where: { id: s.option.id } })).stock).toBe(stockBefore);
    expect(await cancelOverdueOrders(db)).toEqual({ cancelled: [], restricted: [] });
  });

  it("여러 번 동시에 돌려도 주문마다 한 번만 취소되고 이력·감사 로그도 한 건", async () => {
    const s = await shop();
    const ids = [await s.order(), await s.order()];
    for (const id of ids) await makeOverdue(id);
    const runs = await Promise.all([cancelOverdueOrders(db), cancelOverdueOrders(db), cancelOverdueOrders(db)]);
    expect(runs.flatMap((r) => r.cancelled).sort()).toEqual([...ids].sort());
    expect(await db.orderStatusHistory.count({ where: { orderId: { in: ids }, toStatus: "CANCELLED" } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: "order.auto_cancel" } })).toBe(2);
  });

  it("입금 확인과 자동 취소가 겹쳐도 둘 중 하나만 된다(결제됐으면 취소 안 함, 취소됐으면 결제 실패)", async () => {
    for (let i = 0; i < 5; i++) {
      const s = await shop();
      const id = await s.order();
      await makeOverdue(id);
      const [paid, run] = await Promise.all([markOrderPaid(db, { sellerId: s.seller.id, orderId: id, paymentMethod: "BANK_TRANSFER" }), cancelOverdueOrders(db)]);
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      if (paid.ok) {
        expect(o).toMatchObject({ status: "PAID", autoCancelledAt: null });
        expect(run.cancelled).not.toContain(id);
      } else {
        expect(o).toMatchObject({ status: "CANCELLED", autoCancelledAt: expect.any(Date) });
        expect(run.cancelled).toContain(id);
      }
    }
  });

  it("기한 1시간 전 알림 대상: 기한이 1시간 안에 오는 결제 대기 주문만", async () => {
    const s = await shop();
    const soon = await s.order();
    const later = await s.order();
    const overdue = await s.order();
    const paid = await s.order();
    const now = Date.now();
    await db.order.update({ where: { id: soon }, data: { paymentDueAt: new Date(now + 30 * 60 * 1000) } });
    await db.order.update({ where: { id: later }, data: { paymentDueAt: new Date(now + 2 * HOUR) } });
    await db.order.update({ where: { id: overdue }, data: { paymentDueAt: new Date(now - 60 * 1000) } });
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: paid, paymentMethod: "CARD" });
    await db.order.update({ where: { id: paid }, data: { paymentDueAt: new Date(now + 30 * 60 * 1000) } });
    expect((await listPaymentDueSoon(db)).map((o) => o.id)).toEqual([soon]);
  });
});

describe("자동 구매 제한", () => {
  it("미입금 자동 취소 3회면 30일 동안 그 쇼핑몰에서만 새 주문이 막힌다(403·문구), 다른 구매자·다른 쇼핑몰은 그대로", async () => {
    const s = await shop();
    const other = await shop();
    const otherBuyer = await createLoginBuyer(s.seller.id, s.grade.id);
    for (let i = 0; i < 2; i++) await makeOverdue(await s.order());
    expect((await cancelOverdueOrders(db)).restricted).toEqual([]);
    expect(await s.place()).toMatchObject({ ok: true });
    await db.order.updateMany({ where: { buyerMemberId: s.buyer.id, status: "PENDING_PAYMENT" }, data: { paymentDueAt: new Date(Date.now() - HOUR), createdAt: new Date(Date.now() - 2 * 24 * HOUR) } });
    const run = await cancelOverdueOrders(db);
    expect(run.restricted).toEqual([{ sellerId: s.seller.id, buyerMemberId: s.buyer.id, endsAt: expect.any(Date) }]);
    const r = await db.buyerPurchaseRestriction.findFirstOrThrow({ where: { buyerMemberId: s.buyer.id } });
    expect(r.endsAt.getTime() - r.startsAt.getTime()).toBe(30 * 24 * HOUR);
    expect(await db.auditLog.count({ where: { action: "buyer.purchase_restriction.create", targetId: s.buyer.id } })).toBe(1);

    expect(await s.place()).toEqual({ ok: false, reason: "purchase_restricted", endsAt: r.endsAt });
    const res = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { ...H, cookie: await buyerCookie(s.seller.id, s.buyer.loginId) },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: addr }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "purchase_restricted", message: purchaseRestrictedMessage(r.endsAt), endsAt: r.endsAt.toISOString() });
    expect(await s.place(otherBuyer.id)).toMatchObject({ ok: true });
    expect(await other.place()).toMatchObject({ ok: true });
    // 기간이 끝나면 다시 주문할 수 있다
    await db.buyerPurchaseRestriction.update({ where: { id: r.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect(await s.place()).toMatchObject({ ok: true });
  });

  it("판매자가 자동 구매 제한을 끄면 횟수가 쌓여도 막지 않는다", async () => {
    const s = await shop();
    await db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, unpaidRestrictionEnabled: false } });
    for (let i = 0; i < 4; i++) await makeOverdue(await s.order());
    expect((await cancelOverdueOrders(db)).restricted).toEqual([]);
    expect(await s.place()).toMatchObject({ ok: true });
  });

  it("판매자가 풀면 바로 주문할 수 있고(감사 로그), 그 뒤 자동 취소 3회가 새로 쌓여야 다시 막힌다. 권한 없는 직원은 403, 제한 없으면 404", async () => {
    const s = await shop();
    for (let i = 0; i < 3; i++) await makeOverdue(await s.order());
    await cancelOverdueOrders(db);
    const c = await sellerCookie(s.owner.email);
    const list = await (await restrictionsRoute(new Request("http://localhost:3000/api/seller/purchase-restrictions", { headers: { ...H, cookie: c } }))).json();
    expect(list.restrictions).toEqual([expect.objectContaining({ buyerMemberId: s.buyer.id, buyerMember: { broadcastNickname: s.buyer.broadcastNickname } })]);

    const lift = (cookie: string) =>
      liftRoute(new Request(`http://localhost:3000/api/seller/purchase-restrictions/${s.buyer.id}/lift`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ reason: "입금 확인" }) }), {
        params: Promise.resolve({ buyerMemberId: s.buyer.id }),
      });
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await lift(await sellerCookie(broadcaster.email))).status).toBe(403);
    expect((await lift(c)).status).toBe(200);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.purchase_restriction.lift", targetId: s.buyer.id } })).toMatchObject({ reason: "입금 확인" });
    const again = await lift(c);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "no_restriction", message: ORDER_ERROR_MESSAGES.no_restriction });

    // 풀린 뒤에는 예전 3회를 세지 않는다
    for (let i = 0; i < 2; i++) await makeOverdue(await s.order());
    expect((await cancelOverdueOrders(db)).restricted).toEqual([]);
    expect(await s.place()).toMatchObject({ ok: true });
    await makeOverdue((await db.order.findFirstOrThrow({ where: { buyerMemberId: s.buyer.id, status: "PENDING_PAYMENT" } })).id);
    expect((await cancelOverdueOrders(db)).restricted).toHaveLength(1);
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
    // 다른 판매자는 이 구매자 제한을 풀 수 없다
    const other = await shop();
    expect(await liftRestriction(db, other.ctx, s.buyer.id)).toEqual({ ok: false, reason: "no_restriction" });
  });

  it("[경합] 세 번째 자동 취소와 새 주문·다른 자동 취소 실행이 겹쳐도 제한은 한 건이고, 제한이 생긴 뒤 만들어진 주문은 없다", async () => {
    for (let round = 0; round < 3; round++) {
      const s = await shop();
      for (let i = 0; i < 3; i++) await makeOverdue(await s.order());
      const results = await Promise.all([
        cancelOverdueOrders(db),
        cancelOverdueOrders(db),
        ...Array.from({ length: 6 }, () => s.place()),
      ]);
      const restrictions = await db.buyerPurchaseRestriction.findMany({ where: { buyerMemberId: s.buyer.id } });
      expect(restrictions).toHaveLength(1);
      const created = results.slice(2).filter((r): r is { ok: true; orderId: string; orderNo: number; totalAmount: number; shippingFee: number } => "ok" in r && r.ok);
      const rejected = results.slice(2).filter((r) => "ok" in r && !r.ok);
      expect(rejected.every((r) => "reason" in r && r.reason === "purchase_restricted")).toBe(true);
      const after = await db.order.count({ where: { id: { in: created.map((c) => c.orderId) }, createdAt: { gt: restrictions[0].startsAt } } });
      expect(after).toBe(0);
      expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
    }
  });
});

describe("검수 후속(#82)", () => {
  it("제한 시작 시각이 주문 트랜잭션 시각보다 늦게 찍혀도 풀지 않았고 끝나기 전이면 막는다", async () => {
    const s = await shop();
    // 주문 트랜잭션이 잠금을 기다리는 사이 제한이 생긴 상황: 제한 startsAt이 주문 쪽 시각보다 뒤
    await db.buyerPurchaseRestriction.create({
      data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(Date.now() + 60_000), endsAt: new Date(Date.now() + 30 * 24 * HOUR) },
    });
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
    expect(await db.order.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
  });

  it("제한 풀기 사유: NUL·짝 없는 서로게이트·201자는 400(500 아님), 줄바꿈·200자는 그대로 저장", async () => {
    const s = await shop();
    const c = await sellerCookie(s.owner.email);
    const restrict = () =>
      db.buyerPurchaseRestriction.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(), endsAt: new Date(Date.now() + HOUR) } });
    const lift = (body: string) =>
      liftRoute(new Request(`http://localhost:3000/api/seller/purchase-restrictions/${s.buyer.id}/lift`, { method: "POST", headers: { ...H, cookie: c }, body }), {
        params: Promise.resolve({ buyerMemberId: s.buyer.id }),
      });
    await restrict();
    // JSON 본문 안의 \u 이스케이프로 보낸다(NUL, 짝 없는 서로게이트)
    for (const body of ['{"reason":"확인\\u0000"}', '{"reason":"확인\\ud800"}', JSON.stringify({ reason: "가".repeat(201) })]) {
      const res = await lift(body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_reason", message: ORDER_ERROR_MESSAGES.invalid_reason });
    }
    expect(await db.buyerPurchaseRestriction.count({ where: { liftedAt: null } })).toBe(1);
    expect((await lift(JSON.stringify({ reason: "입금 확인\n통화함" }))).status).toBe(200);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.purchase_restriction.lift" } })).toMatchObject({ reason: "입금 확인\n통화함" });
    await restrict();
    expect((await lift(JSON.stringify({ reason: "가".repeat(200) }))).status).toBe(200);
    await restrict();
    expect((await lift("{}")).status).toBe(200);
  });

  it("자동 제한을 끈 동안 3건 쌓이고 다시 켠 뒤 1건 취소돼도 제한 없음, 켠 뒤 3건이 되면 제한. 끄더라도 이미 걸린 제한은 그대로", async () => {
    const s = await shop();
    const c = await sellerCookie(s.owner.email);
    const setEnabled = (enabled: boolean) =>
      policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ autoCancelEnabled: true, paymentDueHours: 240, unpaidRestrictionEnabled: enabled }) }));
    expect((await setEnabled(false)).status).toBe(200);
    for (let i = 0; i < 3; i++) await makeOverdue(await s.order());
    expect((await cancelOverdueOrders(db)).restricted).toEqual([]);
    expect((await setEnabled(true)).status).toBe(200);
    expect(await db.sellerOrderPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).toMatchObject({ unpaidRestrictionEnabledAt: expect.any(Date) });
    await makeOverdue(await s.order());
    expect((await cancelOverdueOrders(db)).restricted).toEqual([]);
    expect(await s.place()).toMatchObject({ ok: true });
    for (const o of await db.order.findMany({ where: { buyerMemberId: s.buyer.id, status: "PENDING_PAYMENT" } })) await makeOverdue(o.id);
    await makeOverdue(await s.order());
    expect((await cancelOverdueOrders(db)).restricted).toHaveLength(1);
    // 꺼도 이미 걸린 제한은 남는다
    expect((await setEnabled(false)).status).toBe(200);
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
  });
});

describe("주문 생성 횟수 제한", () => {
  it("같은 구매자는 쇼핑몰당 1분에 10건까지, 넘으면 429와 문구. 다른 구매자는 영향 없고, 1분이 지나면 다시 된다", async () => {
    const s = await shop();
    for (let i = 0; i < ORDER_RATE_LIMIT; i++) expect(await s.place()).toMatchObject({ ok: true });
    expect(await s.place()).toEqual({ ok: false, reason: "order_rate_limited" });
    const res = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { ...H, cookie: await buyerCookie(s.seller.id, s.buyer.loginId) },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: addr }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "order_rate_limited", message: ORDER_ERROR_MESSAGES.order_rate_limited });
    const otherBuyer = await createLoginBuyer(s.seller.id, s.grade.id);
    expect(await s.place(otherBuyer.id)).toMatchObject({ ok: true });
    await db.order.updateMany({ where: { buyerMemberId: s.buyer.id }, data: { createdAt: new Date(Date.now() - 61 * 1000) } });
    expect(await s.place()).toMatchObject({ ok: true });
  });

  it("[경합] 15건을 동시에 넣어도 정확히 10건만 만들어진다", async () => {
    const s = await shop();
    const rs = await Promise.all(Array.from({ length: 15 }, () => s.place()));
    expect(rs.filter((r) => r.ok)).toHaveLength(ORDER_RATE_LIMIT);
    expect(rs.filter((r) => !r.ok && r.reason === "order_rate_limited")).toHaveLength(5);
    expect(await db.order.count({ where: { buyerMemberId: s.buyer.id } })).toBe(ORDER_RATE_LIMIT);
  });
});

describe("구매자 주문 조회 응답", () => {
  it("목록·상세(오류 응답 포함)는 Cache-Control: no-store", async () => {
    const s = await shop();
    const id = await s.order();
    const c = await buyerCookie(s.seller.id, s.buyer.loginId);
    const list = await listRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, { headers: { ...H, cookie: c } }), { params: Promise.resolve({ slug: s.seller.slug }) });
    const detail = await detailRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders/${id}`, { headers: { ...H, cookie: c } }), { params: Promise.resolve({ slug: s.seller.slug, orderId: id }) });
    const missing = await detailRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders/x`, { headers: { ...H, cookie: c } }), { params: Promise.resolve({ slug: s.seller.slug, orderId: "x" }) });
    const anon = await listRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, { headers: H }), { params: Promise.resolve({ slug: s.seller.slug }) });
    for (const [res, status] of [[list, 200], [detail, 200], [missing, 404], [anon, 401]] as const) {
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await detail.json()).paymentDueAt).toEqual(expect.any(String));
  });

  it("재고 부족으로 환불 대상인 결제 주문은 needsRefund와 해요체 안내만 주고 내부 값은 숨긴다. 폐업 쇼핑몰이어도 본인 주문은 보인다", async () => {
    const s = await shop(1);
    const a = await s.order();
    const b = await s.order();
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: a, paymentMethod: "CARD" });
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: b, paymentMethod: "CARD" });
    // 폐업 전에 로그인한 세션으로, 폐업 뒤에도 본인 주문을 볼 수 있는지 확인한다
    const cookie = await buyerCookie(s.seller.id, s.buyer.loginId);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "CLOSED" } });
    const res = await listRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, { headers: { ...H, cookie } }), { params: Promise.resolve({ slug: s.seller.slug }) });
    expect(res.status).toBe(200);
    const orders = (await res.json()).orders as { id: string; needsRefund: boolean; notice: string | null }[];
    const shortage = orders.find((o) => o.id === b)!;
    const ok = orders.find((o) => o.id === a)!;
    expect(shortage).toMatchObject({ needsRefund: true, notice: ORDER_NOTICES.stock_shortage_refund });
    expect(ok).toMatchObject({ needsRefund: false, notice: null });
    for (const o of orders) expect(o).not.toHaveProperty("stockShortageAt");
  });
});
