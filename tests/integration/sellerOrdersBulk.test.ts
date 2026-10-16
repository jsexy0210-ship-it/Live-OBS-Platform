import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as bulkRoute } from "../../app/api/seller/orders/bulk/route";
import { GET as countsRoute } from "../../app/api/seller/orders/counts/route";
import { GET as listRoute } from "../../app/api/seller/orders/route";
import { loginSeller } from "../../lib/server/auth/login";
import { countSellerOrders, kstTodayRange, prepareShipping } from "../../lib/server/orders/bulk";
import { listSellerOrders, queueStateOf } from "../../lib/server/orders/read";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 주문 목록(SA-021) 서버: 구매자 등급·방송 큐 상태·칩 필터·칩 건수·선택 일괄(배송 준비로 변경·송장 일괄 입력)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  let pos = 0;
  // 결제 완료 주문 하나(+ 방송 큐 상태들, 큐가 없으면 queue 생략)
  const order = async (queue: ("WAITING" | "OPENING" | "DONE" | "CANCELLED")[] = [], extra: { address?: boolean } = {}) => {
    const { order: o, item } = await createPaidOrderItem(seller.id, buyer.id);
    for (const status of queue) {
      await db.queueItem.create({
        data: { sellerId: seller.id, orderId: o.id, orderItemId: item.id, status, position: ++pos, receivedAt: new Date(), nicknameSnapshot: "닉", productLabel: "부스터 팩", quantity: 1 },
      }).catch(async () => {
        // 같은 주문 항목에 큐 항목이 여러 개일 수 없으면 항목을 하나 더 만든다
        const second = await db.orderItem.create({ data: { sellerId: seller.id, orderId: o.id, productId: item.productId, optionId: item.optionId, productNameSnapshot: "부스터 팩", optionNameSnapshot: "1팩", unitPrice: 5000, quantity: 1 } });
        await db.queueItem.create({ data: { sellerId: seller.id, orderId: o.id, orderItemId: second.id, status, position: ++pos, receivedAt: new Date(), nicknameSnapshot: "닉", productLabel: "부스터 팩", quantity: 1 } });
      });
    }
    if (extra.address !== false) await db.orderShippingAddress.create({ data: { sellerId: seller.id, orderId: o.id, recipientName: "박받는", phone: "01033334444", zipCode: "06236", address1: "서울시 강남구" } });
    return o;
  };
  const cookie = async () => {
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  return { seller, grade, owner, ctx, buyer, order, cookie };
}
const list = async (s: Awaited<ReturnType<typeof shop>>, q: Parameters<typeof listSellerOrders>[2] = {}) => {
  const r = await listSellerOrders(db, s.ctx, { limit: "100", ...q });
  if (!r.ok) throw new Error("list");
  return r;
};

describe("방송 큐 상태 규칙", () => {
  it("개봉 중이 하나라도 있으면 개봉 중, 아니고 대기가 있으면 개봉 대기, 전부 끝났으면 개봉 완료, 취소만 있거나 없으면 null", () => {
    expect(queueStateOf([])).toBeNull();
    expect(queueStateOf([{ status: "CANCELLED" }])).toBeNull();
    expect(queueStateOf([{ status: "DONE" }, { status: "WAITING" }])).toBe("waiting");
    expect(queueStateOf([{ status: "DONE" }, { status: "WAITING" }, { status: "OPENING" }])).toBe("opening");
    expect(queueStateOf([{ status: "DONE" }, { status: "CANCELLED" }])).toBe("done");
  });
  it("KST 오늘 구간", () => {
    const r = kstTodayRange(new Date("2026-10-06T16:30:00Z")); // KST 10/7 01:30
    expect(r.from.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-07T15:00:00.000Z");
  });
});

describe("목록: 구매자 등급·큐 상태·칩 필터", () => {
  it("행에 구매자 등급과 큐 상태가 있고, queue·refundRequested·trackingMissing 필터가 같은 기준으로 거른다", async () => {
    const s = await shop();
    const waiting = await s.order(["WAITING"]);
    const opening = await s.order(["OPENING"]);
    const mixed = await s.order(["DONE", "WAITING"]);
    const done = await s.order(["DONE"]);
    const none = await s.order([]);
    const refunding = await s.order(["DONE"]);
    const buyer2 = await db.refundRequest.create({ data: { sellerId: s.seller.id, orderId: refunding.id, buyerMemberId: s.buyer.id, reason: "CHANGE_OF_MIND" } });
    expect(buyer2.status).toBe("REQUESTED");
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: done.id, courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT", shippedAt: new Date() } });

    const all = await list(s);
    const row = (id: string) => all.orders.find((o) => o.id === id)!;
    expect(row(waiting.id)).toMatchObject({ queueState: "waiting", shippingPreparedAt: null, buyer: { grade: { id: s.grade.id, displayName: s.grade.displayName } } });
    expect(row(opening.id).queueState).toBe("opening");
    expect(row(mixed.id).queueState).toBe("waiting");
    expect(row(done.id).queueState).toBe("done");
    expect(row(none.id).queueState).toBeNull();
    const ids = async (q: Parameters<typeof listSellerOrders>[2]) => (await list(s, q)).orders.map((o) => o.id).sort();
    expect(await ids({ queue: "waiting" })).toEqual([waiting.id, mixed.id].sort());
    expect(await ids({ queue: "opening" })).toEqual([opening.id]);
    expect(await ids({ queue: "done" })).toEqual([done.id, refunding.id].sort());
    expect(await ids({ refundRequested: "true" })).toEqual([refunding.id]);
    // 송장 미입력 = 결제 완료·발송 전(발송한 주문 제외)
    expect(await ids({ trackingMissing: "true" })).toEqual([waiting.id, opening.id, mixed.id, none.id, refunding.id].sort());
    expect(await listSellerOrders(db, s.ctx, { queue: "x" })).toEqual({ ok: false });
    expect(await listSellerOrders(db, s.ctx, { refundRequested: "yes" })).toEqual({ ok: false });
    expect(await listSellerOrders(db, s.ctx, { trackingMissing: "1" })).toEqual({ ok: false });
  });
});

describe("칩 건수", () => {
  it("목록 필터와 같은 기준으로 센다. 다른 쇼핑몰·법정 보관 주문은 세지 않는다", async () => {
    const s = await shop();
    await s.order(["WAITING"]);
    await s.order(["OPENING"]);
    await s.order(["DONE"]);
    const refunding = await s.order(["DONE"]);
    await db.refundRequest.create({ data: { sellerId: s.seller.id, orderId: refunding.id, buyerMemberId: s.buyer.id, reason: "CHANGE_OF_MIND" } });
    const unpaid = await s.order([]);
    await db.order.update({ where: { id: unpaid.id }, data: { status: "PENDING_PAYMENT", paidAt: null } });
    const cancelled = await s.order([]);
    await db.order.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    const hold = await s.order(["WAITING"]);
    await db.order.update({ where: { id: hold.id }, data: { legalHoldAt: new Date() } });
    const other = await shop();
    await other.order(["WAITING"]);

    const c = await countSellerOrders(db, s.ctx);
    expect(c).toMatchObject({ total: 6, today: 6, unpaid: 1, queueWaiting: 1, queueOpening: 1, queueDone: 2, refundRequested: 1, cancelled: 1, refunded: 0 });
    expect(c.trackingMissing).toBe(4);
    expect(c.todaySales).toBe(5000 * 5);
    // 건수와 같은 필터의 목록 건수가 같다
    expect((await list(s, { trackingMissing: "true" })).orders).toHaveLength(c.trackingMissing);
    expect((await list(s, { queue: "done" })).orders).toHaveLength(c.queueDone);
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    await expect(countSellerOrders(db, { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] })).rejects.toThrow();
  });
});

describe("선택 일괄: 배송 준비로 변경", () => {
  it("개봉 완료 결제 주문만 바뀌고 구매자 안내 기록·로그 추적이 남으며, 나머지는 이유와 함께 건너뛴다", async () => {
    const s = await shop();
    const done = await s.order(["DONE"]);
    const waiting = await s.order(["WAITING"]);
    const noQueue = await s.order([]);
    const shipped = await s.order(["DONE"]);
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: shipped.id, courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT", shippedAt: new Date() } });
    const unpaid = await s.order(["DONE"]);
    await db.order.update({ where: { id: unpaid.id }, data: { status: "PENDING_PAYMENT" } });
    const other = await shop();
    const foreign = await other.order(["DONE"]);

    const r = await prepareShipping(db, s.ctx, [done.id, waiting.id, noQueue.id, shipped.id, unpaid.id, foreign.id]);
    if (!r.ok) throw new Error("bulk");
    expect(r.prepared).toBe(1);
    expect(r.results).toEqual([
      { orderId: done.id, ok: true },
      { orderId: waiting.id, ok: false, reason: "not_opened" },
      { orderId: noQueue.id, ok: false, reason: "not_opened" },
      { orderId: shipped.id, ok: false, reason: "already_shipped" },
      { orderId: unpaid.id, ok: false, reason: "not_paid" },
      { orderId: foreign.id, ok: false, reason: "not_found" },
    ]);
    expect((await db.order.findUniqueOrThrow({ where: { id: done.id } })).shippingPreparedAt).toBeInstanceOf(Date);
    expect((await db.order.findUniqueOrThrow({ where: { id: waiting.id } })).shippingPreparedAt).toBeNull();
    expect(await db.orderNotification.count({ where: { orderId: done.id, kind: "SHIPPING_PREPARED", status: "PENDING" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "order.shipping_prepare", targetId: done.id, actorId: s.owner.id } })).toBe(1);
    // 발송 가능 조건은 그대로: 배송 목록 발송 대기 조건에도 그대로 있다
    expect((await list(s, { trackingMissing: "true" })).orders.map((o) => o.id)).toContain(done.id);
    // 두 번째는 이미 변경됨
    expect(await prepareShipping(db, s.ctx, [done.id])).toMatchObject({ ok: true, prepared: 0, results: [{ orderId: done.id, ok: false, reason: "already_prepared" }] });
    expect((await list(s)).orders.find((o) => o.id === done.id)?.shippingPreparedAt).toBeInstanceOf(Date);
    // 본문 검사·권한
    expect(await prepareShipping(db, s.ctx, [])).toEqual({ ok: false });
    expect(await prepareShipping(db, s.ctx, [done.id, done.id])).toEqual({ ok: false });
    expect(await prepareShipping(db, s.ctx, ["x"])).toEqual({ ok: false });
    expect(await prepareShipping(db, s.ctx, Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`))).toEqual({ ok: false });
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    await expect(prepareShipping(db, { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] }, [noQueue.id])).rejects.toThrow();
  });

  it("같은 주문을 동시에 바꿔도 한 번만 적용된다", async () => {
    const s = await shop();
    const done = await s.order(["DONE"]);
    const [a, b] = await Promise.all([prepareShipping(db, s.ctx, [done.id]), prepareShipping(db, s.ctx, [done.id])]);
    expect([a, b].map((x) => (x.ok ? x.prepared : -1)).sort()).toEqual([0, 1]);
    expect(await db.auditLog.count({ where: { action: "order.shipping_prepare", targetId: done.id } })).toBe(1);
  });
});

describe("경로", () => {
  it("목록 쿼리(queue·refundRequested·trackingMissing)·칩 건수·일괄(배송 준비·송장 일괄 입력)", async () => {
    const s = await shop();
    const cookie = await s.cookie();
    const done = await s.order(["DONE"]);
    const waiting = await s.order(["WAITING"]);
    const url = (path: string) => `http://localhost:3000/api/seller/${path}`;
    const get = (route: (r: Request) => Promise<Response>, path: string) => route(new Request(url(path), { headers: { ...H, cookie } }));
    const post = (path: string, body: unknown) => bulkRoute(new Request(url(path), { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));

    const l = await get(listRoute, "orders?queue=waiting");
    expect((await l.json()).orders.map((o: { id: string }) => o.id)).toEqual([waiting.id]);
    expect((await get(listRoute, "orders?queue=nope")).status).toBe(400);
    const counts = await (await get(countsRoute, "orders/counts")).json();
    expect(counts.counts).toMatchObject({ total: 2, queueWaiting: 1, queueDone: 1, trackingMissing: 2 });

    const prep = await post("orders/bulk", { action: "prepare_shipping", orderIds: [done.id, waiting.id] });
    expect(prep.status).toBe(200);
    expect(await prep.json()).toEqual({ prepared: 1, results: [{ orderId: done.id, ok: true }, { orderId: waiting.id, ok: false, reason: "not_opened" }] });
    expect((await post("orders/bulk", { action: "prepare_shipping", orderIds: [] })).status).toBe(400);
    expect((await post("orders/bulk", { action: "unknown", orderIds: [done.id] })).status).toBe(400);

    const noCourier = await post("orders/bulk", { action: "issue_invoices", orderIds: [done.id] });
    expect(noCourier.status).toBe(400);
    expect((await noCourier.json()).error).toBe("invalid_courier");
    const inv = await post("orders/bulk", { action: "issue_invoices", orderIds: [done.id], courier: "CJ" });
    expect(inv.status).toBe(200);
    expect(await inv.json()).toMatchObject({ issued: 1, failed: 0, results: [{ orderIds: [done.id], ok: true }] });
  });
});
