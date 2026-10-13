import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/seller/invoices/[id]/route";
import { POST as pickupRoute } from "../../app/api/seller/invoices/[id]/pickup-request/route";
import { POST as retryRoute } from "../../app/api/seller/invoices/[id]/retry/route";
import { GET as exportRoute } from "../../app/api/seller/invoices/export/route";
import { POST as planRoute } from "../../app/api/seller/invoices/plan/route";
import { POST as printRoute } from "../../app/api/seller/invoices/print/route";
import { GET as listRoute, POST as issueRoute } from "../../app/api/seller/invoices/route";
import { loginSeller } from "../../lib/server/auth/login";
import { FakeInvoiceProvider, MockInvoiceProvider, setInvoiceProviderForTest } from "../../lib/server/invoices/provider";
import { exportInvoices, getInvoice, issueInvoices, listInvoices, planInvoices, printInvoices, requestInvoicePickup, retryInvoice, syncInvoiceTracking } from "../../lib/server/invoices/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 송장 발급(모의)·출력·추적(SA-027·028, ORDER_SHIPPING). 어댑터는 모의 — 주문 상태·배송 레코드는 바꾸지 않는다.
const fake = new FakeInvoiceProvider();
beforeEach(async () => {
  fake.issued.length = 0;
  fake.pickups.length = 0;
  fake.failIssue.length = 0;
  fake.events.clear();
  setInvoiceProviderForTest(fake);
  await resetDb();
});
afterEach(() => setInvoiceProviderForTest(null));
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await db.buyerMember.update({ where: { id: (await createBuyer(seller.id, grade.id)).id }, data: { broadcastNickname: "별빛사냥꾼" } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  let n = 0;
  const order = async (o: { status?: "PENDING_PAYMENT" | "PAID"; zip?: string; address1?: string; recipient?: string; phone?: string; createdAt?: Date } = {}) => {
    const created = await db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: ++n,
        buyerMemberId: buyer.id,
        broadcastNicknameSnapshot: buyer.broadcastNickname,
        totalAmount: 10000,
        status: o.status ?? "PAID",
        paidAt: new Date(),
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
    await db.orderShippingAddress.create({ data: { sellerId: seller.id, orderId: created.id, recipientName: o.recipient ?? "박받는", phone: o.phone ?? "01033334444", zipCode: o.zip ?? "06236", address1: o.address1 ?? "서울시 강남구", address2: "101동", isRemote: false } });
    return created;
  };
  const staff = async (permissions: string[]) => {
    const u = await createSellerUser(seller.id, { permissions: permissions as never });
    return { ...ctx, actorId: u.id, isOwner: false, permissions: permissions as never } as TenantContext;
  };
  const cookie = async () => {
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  return { seller, owner, ctx, buyer, order, staff, cookie };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const issue = async (s: Shop, orderIds: string[], extra: Record<string, unknown> = {}) => {
  const r = await issueInvoices(db, s.ctx, { orderIds, courier: "CJ", ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("발급 계획 · 합배송 · 주소 확인", () => {
  it("같은 받는 분 묶기는 한 상자로, 우편번호 없는 주문은 주소 확인으로 나누고, 보낼 수 없는 주문은 이유와 함께 뺀다", async () => {
    const s = await shop();
    const a1 = await s.order();
    const a2 = await s.order();
    const b = await s.order({ recipient: "다른사람", address1: "부산시" });
    const bad = await s.order({ zip: "" });
    const unpaid = await s.order({ status: "PENDING_PAYMENT" });
    const other = await shop();
    const foreign = await other.order();
    const ids = [a1.id, a2.id, b.id, bad.id, unpaid.id, foreign.id];

    const bundled = await planInvoices(db, s.ctx, { orderIds: ids, bundle: true });
    if (!bundled.ok) throw new Error(bundled.reason);
    expect(bundled.summary).toEqual({ invoices: 2, orders: 3, addressIssues: 1, bundles: 1 });
    expect(bundled.rows.find((r) => r.orderId === a1.id)).toMatchObject({ groupNo: 1, bundleCount: 2, addressIssue: null, shippingAddress: { recipientName: "박받는", zipCode: "06236" } });
    expect(bundled.rows.find((r) => r.orderId === bad.id)).toMatchObject({ addressIssue: "zip_missing" });
    expect(bundled.rejected).toEqual(
      expect.arrayContaining([
        { orderId: unpaid.id, reason: "not_ready" },
        { orderId: foreign.id, reason: "not_found" },
      ]),
    );
    const single = await planInvoices(db, s.ctx, { orderIds: ids, bundle: false });
    expect(single.ok && single.summary).toEqual({ invoices: 3, orders: 3, addressIssues: 1, bundles: 0 });
    expect(await planInvoices(db, s.ctx, { orderIds: [] })).toEqual({ ok: false, reason: "invalid_request" });
    expect(await planInvoices(db, s.ctx, { orderIds: ["x"] })).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("받는 분 이름·주소는 개인정보 권한이 있을 때만 내보내고 로그 추적에 남긴다. 권한 없는 직원은 주소 없이 묶음만 본다", async () => {
    const s = await shop();
    const o = await s.order();
    const noPii = await s.staff(["ORDER_SHIPPING"]);
    const r1 = await planInvoices(db, noPii, { orderIds: [o.id] });
    expect(r1.ok && r1.rows[0].shippingAddress).toBeNull();
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", targetType: "InvoicePlan" } })).toBe(0);
    const r2 = await planInvoices(db, s.ctx, { orderIds: [o.id] });
    expect(r2.ok && r2.rows[0].shippingAddress).toMatchObject({ recipientName: "박받는" });
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", targetType: "InvoicePlan", actorId: s.owner.id } })).toBe(1);
    const noShip = await s.staff(["PRODUCT_MANAGE"]);
    await expect(planInvoices(db, noShip, { orderIds: [o.id] })).rejects.toThrow();
  });
});

describe("송장 발급(모의)", () => {
  it("묶음마다 송장 하나, 주소 확인 필요 주문은 빠지고, 주문 상태·배송 레코드는 바뀌지 않는다", async () => {
    const s = await shop();
    const a1 = await s.order();
    const a2 = await s.order();
    const b = await s.order({ recipient: "다른사람", address1: "부산시" });
    const bad = await s.order({ zip: "" });
    const r = await issue(s, [a1.id, a2.id, b.id, bad.id], { bundle: true });
    expect(r).toMatchObject({ issued: 2, failed: 0, courierName: "CJ대한통운" });
    expect(r.skipped).toEqual([{ orderIds: [bad.id], reason: "zip_missing" }]);
    const invs = await db.shipmentInvoice.findMany({ where: { sellerId: s.seller.id }, include: { orders: true, events: true }, orderBy: { createdAt: "asc" } });
    expect(invs).toHaveLength(2);
    expect(invs.map((i) => i.orders.length).sort()).toEqual([1, 2]);
    for (const i of invs) {
      expect(i).toMatchObject({ status: "ISSUED", mock: true, courier: "CJ", failureCode: null, trackingNumber: expect.stringMatching(/^\d{12}$/) });
      expect(i.events.map((e) => e.kind)).toEqual(["ISSUED"]);
    }
    expect(fake.issued).toHaveLength(2);
    expect(fake.issued.find((i) => i.orderIds.length === 2)?.recipient).toMatchObject({ name: "박받는", zipCode: "06236" });
    expect(await db.shipment.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: a1.id } })).status).toBe("PAID");
    expect(await db.auditLog.count({ where: { action: "invoice.issue", actorId: s.owner.id } })).toBe(2);
    // 이미 송장이 있는 주문은 다시 발급되지 않는다
    const again = await issue(s, [a1.id, a2.id]);
    expect(again).toMatchObject({ issued: 0, results: [], skipped: [{ orderIds: [a1.id], reason: "already_invoiced" }, { orderIds: [a2.id], reason: "already_invoiced" }] });
  });

  it("택배사는 요청값 > 배송 설정의 기본 택배사, 둘 다 없거나 모르는 값이면 400", async () => {
    const s = await shop();
    const o = await s.order();
    expect(await issueInvoices(db, s.ctx, { orderIds: [o.id] })).toEqual({ ok: false, reason: "invalid_courier" });
    expect(await issueInvoices(db, s.ctx, { orderIds: [o.id], courier: "X" })).toEqual({ ok: false, reason: "invalid_courier" });
    await db.sellerShippingPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, defaultCourier: "HANJIN" }, update: { defaultCourier: "HANJIN" } });
    expect(await issueInvoices(db, s.ctx, { orderIds: [o.id] })).toMatchObject({ ok: true, courier: "HANJIN", issued: 1 });
  });

  it("같은 주문을 동시에 발급해도 송장은 하나만 만들어진다", async () => {
    const s = await shop();
    const o = await s.order();
    const [x, y] = await Promise.all([issueInvoices(db, s.ctx, { orderIds: [o.id], courier: "CJ" }), issueInvoices(db, s.ctx, { orderIds: [o.id], courier: "CJ" })]);
    expect(await db.shipmentInvoice.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect([x, y].filter((r) => r.ok && r.issued === 1)).toHaveLength(1);
  });

  it("업체 실패는 번호 없는 송장으로 남고 실패 사유가 보이며, 다시 발급하면 같은 송장·주문으로 이어진다. 권한 없는 직원은 막힌다", async () => {
    const s = await shop();
    const o1 = await s.order();
    const o2 = await s.order({ recipient: "다른사람", address1: "부산시" });
    fake.failIssue.push("carrier_error");
    const r = await issue(s, [o1.id, o2.id]);
    expect(r).toMatchObject({ issued: 1, failed: 1 });
    const failed = r.results.find((x) => !x.ok)!;
    expect(failed).toMatchObject({ reason: "carrier_error", orderIds: [o1.id] });
    const row = await db.shipmentInvoice.findUniqueOrThrow({ where: { id: failed.invoiceId! } });
    expect(row).toMatchObject({ status: "FAILED", trackingNumber: null, failureCode: "carrier_error", attempts: 1 });
    const list = await listInvoices(db, s.ctx, { status: "FAILED" });
    expect(list.ok && list.invoices[0]).toMatchObject({ id: failed.invoiceId, issuing: false, failureCode: "carrier_error" });

    const staff = await s.staff(["PRODUCT_MANAGE"]);
    await expect(retryInvoice(db, staff, failed.invoiceId!)).rejects.toThrow();
    const retry = await retryInvoice(db, s.ctx, failed.invoiceId!);
    expect(retry).toMatchObject({ ok: true, result: { ok: true, invoiceId: failed.invoiceId, trackingNumber: expect.stringMatching(/^\d{12}$/) } });
    expect(await db.shipmentInvoice.findUniqueOrThrow({ where: { id: failed.invoiceId! } })).toMatchObject({ status: "ISSUED", attempts: 2, failureCode: null });
    expect(await retryInvoice(db, s.ctx, failed.invoiceId!)).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await retryInvoice(db, s.ctx, "nope")).toEqual({ ok: false, reason: "not_found" });
    // 발급 중인 송장(5분 안)은 다시 발급하지 못한다
    const issuing = await db.shipmentInvoice.create({ data: { sellerId: s.seller.id, courier: "CJ", failureCode: "issuing" } });
    expect(await retryInvoice(db, s.ctx, issuing.id)).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("어댑터가 예외를 던져도 송장은 provider_error로 남는다", async () => {
    const s = await shop();
    const o = await s.order();
    const boom = new MockInvoiceProvider();
    boom.issue = async () => {
      throw new Error("down");
    };
    setInvoiceProviderForTest(boom);
    const r = await issue(s, [o.id]);
    expect(r.results[0]).toMatchObject({ ok: false, reason: "provider_error" });
    expect(await db.shipmentInvoice.findFirstOrThrow({ where: { sellerId: s.seller.id } })).toMatchObject({ status: "FAILED", failureCode: "provider_error" });
  });
});

describe("출력 · 추적", () => {
  it("출력하면 출력됨으로 바뀌고 라벨을 주며, 다시 출력은 상태를 바꾸지 않는다. 번호 없는 송장·모르는 방식은 거부", async () => {
    const s = await shop();
    const o1 = await s.order();
    const o2 = await s.order({ recipient: "다른사람", address1: "부산시" });
    const r = await issue(s, [o1.id, o2.id]);
    const [i1, i2] = r.results.map((x) => x.invoiceId!);
    expect(await printInvoices(db, s.ctx, { format: "PDF" })).toEqual({ ok: false, reason: "invalid_format" });
    const p = await printInvoices(db, s.ctx, { invoiceIds: [i1], format: "LABEL_100X150" });
    if (!p.ok) throw new Error(p.reason);
    expect(p).toMatchObject({ printed: 1, results: [{ invoiceId: i1, ok: true, reprint: false }] });
    expect(p.labels[0]).toMatchObject({ invoiceId: i1, courierName: "CJ대한통운", mock: true, format: "LABEL_100X150", recipient: { name: "박받는" }, orders: [{ nickname: "별빛사냥꾼" }] });
    const row = await db.shipmentInvoice.findUniqueOrThrow({ where: { id: i1 }, include: { events: true } });
    expect(row).toMatchObject({ status: "PRINTED", printFormat: "LABEL_100X150", printedAt: expect.any(Date) });
    expect(row.events.map((e) => e.kind).sort()).toEqual(["ISSUED", "PRINTED"]);
    const again = await printInvoices(db, s.ctx, { invoiceIds: [i1], format: "A4_2UP" });
    expect(again.ok && again.results[0]).toMatchObject({ ok: true, reprint: true });
    expect((await db.shipmentInvoice.findUniqueOrThrow({ where: { id: i1 } })).printFormat).toBe("LABEL_100X150");
    // 안 넣으면 아직 출력하지 않은 송장 전부
    const rest = await printInvoices(db, s.ctx, { format: "A4_2UP" });
    expect(rest.ok && rest.results).toEqual([{ invoiceId: i2, ok: true, reprint: false }]);
    const failed = await db.shipmentInvoice.create({ data: { sellerId: s.seller.id, courier: "CJ", failureCode: "carrier_error" } });
    const bad = await printInvoices(db, s.ctx, { invoiceIds: [failed.id, "00000000-0000-4000-8000-000000000000"], format: "A4_2UP" });
    expect(bad.ok && bad.results).toEqual([
      { invoiceId: failed.id, ok: false, reason: "invalid_transition" },
      { invoiceId: "00000000-0000-4000-8000-000000000000", ok: false, reason: "not_found" },
    ]);
    // 개인정보 권한이 없으면 라벨에 받는 분이 없다
    const noPii = await s.staff(["ORDER_SHIPPING"]);
    const lbl = await printInvoices(db, noPii, { invoiceIds: [i2], format: "A4_2UP" });
    expect(lbl.ok && lbl.labels[0]).toMatchObject({ recipient: null });
  });

  it("출력 전에는 집하되지 않고, 출력 뒤 모의 추적이 집하 → 배송 완료로 진행하며 상태는 되돌아가지 않는다", async () => {
    const s = await shop();
    const o = await s.order();
    const r = await issue(s, [o.id]);
    const id = r.results[0].invoiceId!;
    setInvoiceProviderForTest(new MockInvoiceProvider());
    await syncInvoiceTracking(db, s.seller.id);
    expect((await db.shipmentInvoice.findUniqueOrThrow({ where: { id } })).status).toBe("ISSUED");
    await printInvoices(db, s.ctx, { invoiceIds: [id], format: "LABEL_100X150" });
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    await db.shipmentInvoice.update({ where: { id }, data: { printedAt: hoursAgo(3) } });
    await syncInvoiceTracking(db, s.seller.id);
    expect(await db.shipmentInvoice.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PICKED_UP", pickedUpAt: expect.any(Date), deliveredAt: null });
    await db.shipmentInvoice.update({ where: { id }, data: { printedAt: hoursAgo(40) } });
    await db.shipmentInvoiceEvent.updateMany({ where: { invoiceId: id, kind: "PRINTED" }, data: { at: hoursAgo(40) } });
    await db.shipmentInvoiceEvent.updateMany({ where: { invoiceId: id, kind: "ISSUED" }, data: { at: hoursAgo(41) } });
    await db.shipmentInvoiceEvent.updateMany({ where: { invoiceId: id, kind: "PICKED_UP" }, data: { at: hoursAgo(38) } });
    await syncInvoiceTracking(db, s.seller.id);
    await syncInvoiceTracking(db, s.seller.id);
    const done = await db.shipmentInvoice.findUniqueOrThrow({ where: { id }, include: { events: true } });
    expect(done).toMatchObject({ status: "DELIVERED", deliveredAt: expect.any(Date) });
    expect(done.events.map((e) => e.kind).sort()).toEqual(["DELIVERED", "IN_TRANSIT", "ISSUED", "OUT_FOR_DELIVERY", "PICKED_UP", "PRINTED"]);
    const detail = await getInvoice(db, s.ctx, id);
    expect(detail?.events[0]).toMatchObject({ kind: "DELIVERED", source: "CARRIER", note: "배송 완료" });
    expect(detail?.events.at(-1)).toMatchObject({ kind: "ISSUED", source: "SELLER" });
    expect(detail?.recipient).toMatchObject({ name: "박받는" });
    // 배송 레코드·주문은 여전히 그대로(모의)
    expect(await db.shipment.count({ where: { sellerId: s.seller.id } })).toBe(0);
  });

  it("집하 지연(출력 24시간 뒤 미집하)을 표시하고, 집하 요청 다시 보내기는 출력됨 송장만 받는다", async () => {
    const s = await shop();
    const o = await s.order();
    const id = (await issue(s, [o.id])).results[0].invoiceId!;
    expect(await requestInvoicePickup(db, s.ctx, id)).toEqual({ ok: false, reason: "invalid_transition" });
    await printInvoices(db, s.ctx, { invoiceIds: [id], format: "A4_2UP" });
    await db.shipmentInvoice.update({ where: { id }, data: { printedAt: new Date(Date.now() - 25 * 3_600_000) } });
    // 택배사가 아직 집하하지 않은 상황(추적 이벤트 없음)
    fake.events.set((await db.shipmentInvoice.findUniqueOrThrow({ where: { id } })).trackingNumber!, []);
    const l = await listInvoices(db, s.ctx);
    expect(l.ok && l.invoices[0]).toMatchObject({ status: "PRINTED", pickupDelayed: true });
    expect(await requestInvoicePickup(db, s.ctx, id)).toEqual({ ok: true });
    expect(await requestInvoicePickup(db, s.ctx, id)).toEqual({ ok: true });
    expect(fake.pickups).toHaveLength(2);
    expect(await db.shipmentInvoiceEvent.count({ where: { invoiceId: id, kind: "PICKUP_REQUESTED" } })).toBe(1);
    expect(await requestInvoicePickup(db, s.ctx, "nope")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("목록 · 내려받기 · 경로", () => {
  it("상태별 건수·검색·커서·다른 쇼핑몰 격리, CSV에는 실명·주소가 없다", async () => {
    const s = await shop();
    const orders = [await s.order({ recipient: "가", address1: "a" }), await s.order({ recipient: "나", address1: "b" }), await s.order({ recipient: "다", address1: "c" })];
    const ids = (await issue(s, orders.map((o) => o.id))).results.map((r) => r.invoiceId!);
    await printInvoices(db, s.ctx, { invoiceIds: [ids[0]], format: "A4_2UP" });
    const other = await shop();
    await issue(other, [(await other.order()).id]);

    const all = await listInvoices(db, s.ctx);
    if (!all.ok) throw new Error(all.reason);
    expect(all.invoices).toHaveLength(3);
    expect(all.counts).toEqual({ ISSUED: 2, PRINTED: 1 });
    expect(all).toMatchObject({ total: 3, unprinted: 2, mock: true });
    expect(all.invoices[0]).toMatchObject({ nickname: "별빛사냥꾼", orderCount: 1, courierName: "CJ대한통운" });
    const printed = await listInvoices(db, s.ctx, { status: "PRINTED" });
    expect(printed.ok && printed.invoices.map((i) => i.id)).toEqual([ids[0]]);
    const num = (await db.shipmentInvoice.findUniqueOrThrow({ where: { id: ids[1] } })).trackingNumber!;
    const byNum = await listInvoices(db, s.ctx, { q: `${num.slice(0, 4)} ${num.slice(4, 8)}` });
    expect(byNum.ok && byNum.invoices.map((i) => i.id)).toEqual([ids[1]]);
    expect((await listInvoices(db, s.ctx, { q: "별빛" })).ok).toBe(true);
    const p1 = await listInvoices(db, s.ctx, { limit: "2" });
    if (!p1.ok || !p1.nextCursor) throw new Error("page");
    const p2 = await listInvoices(db, s.ctx, { limit: "2", cursor: p1.nextCursor });
    expect(p2.ok && [...p1.invoices, ...p2.invoices].map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(await listInvoices(db, s.ctx, { status: "X" })).toEqual({ ok: false, reason: "invalid_request" });
    expect(await getInvoice(db, other.ctx, ids[0])).toBeNull();
    expect(await retryInvoice(db, other.ctx, ids[0])).toEqual({ ok: false, reason: "not_found" });

    const out = await exportInvoices(db, s.ctx, { status: "PRINTED" });
    if (!out.ok) throw new Error("export");
    const lines = out.csv.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("택배사,송장번호,받는 분(닉네임),주문 건수,상태,발급 시각,출력 시각,집하 시각,배송 완료 시각,모의 발급");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("CJ대한통운");
    expect(lines[1]).toContain("출력됨");
    expect(out.csv).not.toContain("박받는");
    expect(await db.auditLog.count({ where: { action: "invoice.export", actorId: s.owner.id } })).toBe(1);
  });

  it("경로: 계획 → 발급 → 목록 → 출력 → 추적 상세 → 다시 발급·집하 요청·내려받기, 권한 없으면 403", async () => {
    const s = await shop();
    const cookie = await s.cookie();
    const call = async (route: (r: Request, c: never) => Promise<Response>, path: string, init: { method?: string; body?: unknown } = {}, ctxArg?: unknown) => {
      const res = await route(new Request(`http://localhost:3000/api/seller/${path}`, { method: init.method ?? "GET", headers: { ...H, cookie }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), ctxArg as never);
      return { status: res.status, res };
    };
    const a1 = await s.order();
    const a2 = await s.order();
    const bad = await s.order({ zip: "" });
    const plan = await call(planRoute, "invoices/plan", { method: "POST", body: { orderIds: [a1.id, a2.id, bad.id], bundle: true } });
    expect(plan.status).toBe(200);
    expect((await plan.res.json()).summary).toEqual({ invoices: 1, orders: 2, addressIssues: 1, bundles: 1 });
    const badReq = await call(issueRoute, "invoices", { method: "POST", body: { orderIds: [] } });
    expect(badReq.status).toBe(400);
    expect(await badReq.res.json()).toEqual({ error: "invalid_request", message: "요청을 확인해 주십시오" });
    const noCourier = await call(issueRoute, "invoices", { method: "POST", body: { orderIds: [a1.id] } });
    expect(noCourier.status).toBe(400);
    const issued = await call(issueRoute, "invoices", { method: "POST", body: { orderIds: [a1.id, a2.id, bad.id], bundle: true, courier: "LOTTE" } });
    expect(issued.status).toBe(200);
    const ib = await issued.res.json();
    expect(ib).toMatchObject({ issued: 1, failed: 0, skipped: [{ orderIds: [bad.id], reason: "zip_missing" }] });
    const invoiceId = ib.results[0].invoiceId as string;

    const list = await call(listRoute, "invoices");
    const lb = await list.res.json();
    expect(lb).toMatchObject({ total: 1, unprinted: 1, mock: true, invoices: [{ id: invoiceId, status: "ISSUED", orderCount: 2 }] });
    expect((await call(listRoute, "invoices?status=X")).status).toBe(400);
    const pr = await call(printRoute, "invoices/print", { method: "POST", body: { format: "LABEL_100X150" } });
    expect(await pr.res.json()).toMatchObject({ printed: 1, labels: [{ invoiceId, orders: [{}, {}] }] });
    expect((await call(printRoute, "invoices/print", { method: "POST", body: { format: "BAD" } })).status).toBe(400);
    const detail = await call(detailRoute, `invoices/${invoiceId}`, {}, { params: Promise.resolve({ id: invoiceId }) });
    expect((await detail.res.json()).invoice).toMatchObject({ id: invoiceId, status: "PRINTED", events: [{ kind: "PRINTED" }, { kind: "ISSUED" }] });
    expect((await call(detailRoute, "invoices/nope", {}, { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    const pk = await call(pickupRoute, `invoices/${invoiceId}/pickup-request`, { method: "POST", body: {} }, { params: Promise.resolve({ id: invoiceId }) });
    expect(pk.status).toBe(200);
    const rt = await call(retryRoute, `invoices/${invoiceId}/retry`, { method: "POST", body: {} }, { params: Promise.resolve({ id: invoiceId }) });
    expect(rt.status).toBe(409);
    expect(await rt.res.json()).toEqual({ error: "invalid_transition", message: "처리할 수 없는 상태입니다. 화면을 새로 고쳐 주십시오" });
    const csv = await call(exportRoute, "invoices/export?status=PRINTED");
    expect(csv.status).toBe(200);
    expect(csv.res.headers.get("content-type")).toContain("text/csv");
    expect(csv.res.headers.get("content-disposition")).toContain("invoices-");
    expect((await call(exportRoute, "invoices/export?status=X")).status).toBe(400);

    const staff = await s.staff(["PRODUCT_MANAGE"]);
    const u = await db.sellerUser.findUniqueOrThrow({ where: { id: staff.actorId } });
    const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    const denied = await listRoute(new Request("http://localhost:3000/api/seller/invoices", { headers: { ...H, cookie: `lo_seller=${r.token}` } }));
    expect(denied.status).toBe(403);
  });
});
