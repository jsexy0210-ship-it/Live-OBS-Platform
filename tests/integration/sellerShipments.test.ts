import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as deliverRoute } from "../../app/api/seller/shipments/deliver/route";
import { GET as listRoute, POST as shipRoute } from "../../app/api/seller/shipments/route";
import { loginSeller } from "../../lib/server/auth/login";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 배송 처리(GET·POST /api/seller/shipments, POST /api/seller/shipments/deliver). ORDER_SHIPPING 권한, 테넌트 격리,
// 탭(발송 대기·배송 중·배송 완료), 커서, 기존 발송(shipOrder)·배송 완료(completeDelivery) 규칙 재사용.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await db.buyerMember.update({ where: { id: (await createBuyer(seller.id, grade.id)).id }, data: { broadcastNickname: "배송닉" } });
  let n = 0;
  // 주문 하나. 기본은 결제 완료·배송지 있음(발송 대기)
  const order = async (data: { status?: "PENDING_PAYMENT" | "PAID" | "REFUNDED"; createdAt?: Date; address?: boolean; shortage?: boolean; legalHold?: boolean } = {}) => {
    const o = await db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: ++n,
        buyerMemberId: buyer.id,
        broadcastNicknameSnapshot: buyer.broadcastNickname,
        totalAmount: 10000,
        status: data.status ?? "PAID",
        paidAt: (data.status ?? "PAID") === "PENDING_PAYMENT" ? null : new Date(),
        stockShortageAt: data.shortage ? new Date() : null,
        legalHoldAt: data.legalHold ? new Date() : null,
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });
    if (data.address !== false) {
      await db.orderShippingAddress.create({ data: { sellerId: seller.id, orderId: o.id, recipientName: "박받는", phone: "01033334444", zipCode: "06236", address1: "서울시 강남구", isRemote: false } });
    }
    return o;
  };
  return { seller, grade, buyer, order, cookie: await cookieOf(owner.email) };
}

async function list(cookie: string, qs = "") {
  const r = await listRoute(new Request(`http://localhost:3000/api/seller/shipments${qs}`, { headers: { host: H.host, cookie } }));
  return { status: r.status, body: await r.json() };
}
async function ship(cookie: string, items: unknown) {
  const r = await shipRoute(new Request("http://localhost:3000/api/seller/shipments", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ items }) }));
  return { status: r.status, body: await r.json() };
}
async function deliver(cookie: string, orderIds: unknown) {
  const r = await deliverRoute(new Request("http://localhost:3000/api/seller/shipments/deliver", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ orderIds }) }));
  return { status: r.status, body: await r.json() };
}
const ids = (b: { shipments: { orderId: string }[] }) => b.shipments.map((s) => s.orderId);

describe("배송 처리 목록 GET /api/seller/shipments", () => {
  it("발송 대기 탭은 지금 발송할 수 있는 주문만(결제 완료·배송지 있음·재고 차감됨·발송 전·법정 보관 아님), 다른 쇼핑몰 주문은 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const ready = await a.order();
    await a.order({ status: "PENDING_PAYMENT" });
    await a.order({ status: "REFUNDED" });
    await a.order({ address: false });
    await a.order({ shortage: true });
    await a.order({ legalHold: true });
    const shipped = await a.order();
    await db.shipment.create({ data: { sellerId: a.seller.id, orderId: shipped.id, courier: "CJ", trackingNumber: "123456789012", shippedAt: new Date() } });
    await b.order();
    const r = await list(a.cookie);
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([ready.id]);
    expect(ids((await list(a.cookie, "?tab=in_transit")).body)).toEqual([shipped.id]);
    expect((await list(a.cookie, "?tab=delivered")).body.shipments).toEqual([]);
  });

  it("송장 입력 → 배송 중 탭, 배송 완료 → 배송 완료 탭으로 옮겨 가고, 송장번호·주문번호로 찾는다", async () => {
    const s = await shop();
    const o = await s.order();
    const sent = await ship(s.cookie, [{ orderId: o.id, courier: "CJ", trackingNumber: "1234-5678-9012" }]);
    expect(sent.status).toBe(200);
    expect(sent.body.results).toEqual([{ orderId: o.id, ok: true, shipment: expect.objectContaining({ courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT" }) }]);
    expect((await list(s.cookie)).body.shipments).toEqual([]);
    const transit = (await list(s.cookie, "?tab=in_transit&q=123456789012")).body.shipments;
    expect(transit).toMatchObject([{ orderId: o.id, orderNo: o.orderNo, shipment: { courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT" } }]);
    expect(ids((await list(s.cookie, `?tab=in_transit&q=${o.orderNo}`)).body)).toEqual([o.id]);

    const done = await deliver(s.cookie, [o.id]);
    expect(done.body.results).toMatchObject([{ orderId: o.id, ok: true }]);
    expect((await list(s.cookie, "?tab=in_transit")).body.shipments).toEqual([]);
    expect(ids((await list(s.cookie, "?tab=delivered")).body)).toEqual([o.id]);
  });

  it("(createdAt, id) 커서로 끝까지 넘기면 같은 시각 주문도 빠짐·겹침 없이 모두 나온다. 잘못된 탭·커서·limit·날짜는 400", async () => {
    const s = await shop();
    const at = new Date("2026-10-01T00:00:00Z");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await s.order({ createdAt: at }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await list(s.cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...ids(r.body));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(5);
    expect(new Set(seen)).toEqual(new Set(made.map((o) => o.id)));
    expect(ids((await list(s.cookie, "?from=2026-10-01&to=2026-10-01")).body).length).toBe(5);
    expect((await list(s.cookie, "?from=2026-10-02")).body.shipments).toEqual([]);
    for (const qs of ["?tab=shipped", "?cursor=bad", "?limit=0", "?from=2026-13-01", `?q=${"가".repeat(51)}`]) expect((await list(s.cookie, qs)).status, qs).toBe(400);
  });

  it("받는 분 정보는 개인정보 권한이 있을 때만 넣고(열람 기록), 없으면 도서산간 여부만. 받는 분 이름 검색도 권한이 있을 때만", async () => {
    const s = await shop();
    const o = await s.order();
    const noPii = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] })).email);
    const pii = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING", "CUSTOMER_PII_VIEW"] })).email);
    expect((await list(noPii)).body.shipments[0].shippingAddress).toEqual({ isRemote: false });
    expect((await list(noPii, `?q=${encodeURIComponent("박받")}`)).body.shipments).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "customer.pii.view" } })).toBe(0);
    expect((await list(pii, `?q=${encodeURIComponent("박받")}`)).body.shipments[0].shippingAddress).toMatchObject({ recipientName: "박받는", phone: "01033334444" });
    // 일치하는 받는 분이 없어도 이름으로 찾았으면 기록한다(0건, 검색어는 남기지 않음)
    expect((await list(pii, `?q=${encodeURIComponent("없는사람")}`)).body.shipments).toEqual([]);
    const audits = await db.auditLog.findMany({ where: { action: "customer.pii.view" }, orderBy: { createdAt: "asc" } });
    expect(audits).toMatchObject([
      { targetType: "ShipmentList", reason: "shipment_list_search", after: { orderIds: [o.id], count: 1 } },
      { targetType: "ShipmentList", reason: "shipment_list_search", after: { orderIds: [], count: 0 } },
    ]);
    expect(JSON.stringify(audits)).not.toContain("없는사람");
  });
});

describe("송장 일괄 입력·배송 완료 POST", () => {
  it("주문마다 기존 발송 규칙으로 따로 처리하고 결과를 주문별로 준다(한 건이 실패해도 나머지는 처리)", async () => {
    const a = await shop();
    const b = await shop();
    const ok = await a.order();
    const unpaid = await a.order({ status: "PENDING_PAYMENT" });
    const others = await b.order();
    const r = await ship(a.cookie, [
      { orderId: ok.id, courier: "CJ", trackingNumber: "123456789012" },
      { orderId: unpaid.id, courier: "CJ", trackingNumber: "123456789013" },
      { orderId: others.id, courier: "CJ", trackingNumber: "123456789014" },
      { orderId: crypto.randomUUID(), courier: "NOPE", trackingNumber: "1" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { ok: boolean; error?: string }) => [x.ok, x.error])).toEqual([
      [true, undefined],
      [false, "not_shippable"],
      [false, "not_found"],
      [false, "invalid_shipment"],
    ]);
    expect(r.body.results[1].message).toBe(ORDER_ERROR_MESSAGES_FORMAL.not_shippable);
    // 다른 쇼핑몰 주문은 바뀌지 않는다
    expect(await db.shipment.count({ where: { orderId: others.id } })).toBe(0);

    // 배송 완료도 주문마다: 배송 중이 아닌 주문은 not_deliverable
    const d = await deliver(a.cookie, [ok.id, unpaid.id]);
    expect(d.body.results.map((x: { ok: boolean; error?: string }) => [x.ok, x.error])).toEqual([
      [true, undefined],
      [false, "not_deliverable"],
    ]);
  });

  it("본문 형식(빈 배열·101건·같은 주문 중복·id 형식)이 틀리면 400이고 아무것도 처리하지 않는다", async () => {
    const s = await shop();
    const o = await s.order();
    const item = { orderId: o.id, courier: "CJ", trackingNumber: "123456789012" };
    const many = Array.from({ length: 101 }, () => ({ ...item, orderId: crypto.randomUUID() }));
    for (const items of [[], many, [item, item], [{ ...item, orderId: "x" }], "nope", [null]]) {
      expect((await ship(s.cookie, items)).status).toBe(400);
    }
    for (const orderIds of [[], [o.id, o.id], ["x"], "nope"]) expect((await deliver(s.cookie, orderIds)).status).toBe(400);
    expect(await db.shipment.count()).toBe(0);
  });

  it("ORDER_SHIPPING 없는 직원은 목록·송장 입력·배송 완료 모두 403", async () => {
    const s = await shop();
    const o = await s.order();
    const staff = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["MEMBER_POINTS", "CUSTOMER_PII_VIEW"] })).email);
    expect((await list(staff)).status).toBe(403);
    expect((await ship(staff, [{ orderId: o.id, courier: "CJ", trackingNumber: "123456789012" }])).status).toBe(403);
    expect((await deliver(staff, [o.id])).status).toBe(403);
    expect(await db.shipment.count()).toBe(0);
  });
});
