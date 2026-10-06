import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as retryRoute } from "../../app/api/seller/receipt-requests/[id]/retry/route";
import { GET as sellerListRoute } from "../../app/api/seller/receipt-requests/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/receipt-requests/[id]/withdraw/route";
import { GET as buyerGetRoute, POST as buyerPostRoute } from "../../app/api/shop/[slug]/receipt-requests/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { openBillingKey } from "../../lib/server/billing/secret";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid } from "../../lib/server/queue/service";
import {
  BUYER_RECEIPT_MESSAGES,
  SELLER_RECEIPT_MESSAGES,
  buyerReceiptContext,
  createReceiptRequest,
  isBizNo,
  listSellerReceiptRequests,
  retryReceiptIssue,
  withdrawReceiptRequest,
} from "../../lib/server/receipts/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 현금영수증·세금계산서 신청·발행 상태(SA-024 · SH-005·SH-022, MASTER 배정 2026-10-05): 외부 발급 연동 없이 신청 기록·상태·철회·재시도.
beforeEach(() => {
  vi.stubEnv("BILLING_KEY_SECRET", "test-billing-key-secret-0123456789abcdef");
  return resetDb();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };
const BIZ = "220-81-62517";

async function newOrder(s: { sellerId: string; buyerId: string; optionId: string }, method: "CARD" | "BANK_TRANSFER" | null) {
  const o = await createOrder(db, { sellerId: s.sellerId, buyerMemberId: s.buyerId, items: [{ optionId: s.optionId, quantity: 1 }], consent, shippingAddress: addr });
  if (!o.ok) throw new Error(o.reason);
  if (method) {
    const paid = await markOrderPaid(db, { sellerId: s.sellerId, orderId: o.orderId, paymentMethod: method });
    if (!paid.ok) throw new Error(paid.reason);
  }
  return o.orderId;
}

async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "박스", price: 7000, status: "ON_SALE" } });
  const opt = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1개", stock: 50 } });
  const base = { sellerId: seller.id, buyerId: buyer.id, optionId: opt.id };
  const bankOrder = await newOrder(base, "BANK_TRANSFER");
  const cardOrder = await newOrder(base, "CARD");
  const scope = { sellerId: seller.id, buyerMemberId: buyer.id };
  return { seller, owner, ctx, buyer, other, base, bankOrder, cardOrder, scope };
}
type S = Awaited<ReturnType<typeof setup>>;
const income = { kind: "CASH_RECEIPT_INCOME", identity: "010-2345-6789" };
const tax = { kind: "TAX_INVOICE", identity: BIZ, taxInfo: { companyName: "주식회사 테스트", representative: "홍길동", email: "tax@example.com" } };

describe("현금영수증·세금계산서 신청", () => {
  it("소득공제 신청은 번호를 봉인해 저장하고 발행은 대기로 시작하며, 파트너스 목록·건수·로그 추적에 보인다", async () => {
    const s = await setup();
    const r = await createReceiptRequest(db, s.scope, s.bankOrder, { ...income, orderId: s.bankOrder });
    if (!r.ok) throw new Error(r.reason);
    expect(r.request).toMatchObject({ kind: "CASH_RECEIPT_INCOME", identityLast4: "6789", withdrawnAt: null, taxInfo: null, issue: { status: "PENDING", amount: 10000, attempts: 0, chargeable: true } });
    // 응답에는 번호 원문·봉인 값이 없고 뒤 4자리만 있다. 무작위 UUID·시각에 숫자가 우연히 들어가도 흔들리지 않게 키 집합과 번호 필드 값으로 확인한다.
    expect(Object.keys(r.request).sort()).toEqual(["createdAt", "id", "identityLast4", "issue", "kind", "orderId", "taxInfo", "withdrawnAt"]);
    expect(r.request.identityLast4).toBe("6789");
    const { id: _id, orderId: _orderId, createdAt: _createdAt, issue, ...fields } = r.request;
    expect(JSON.stringify({ ...fields, issue: { status: issue?.status, amount: issue?.amount } })).not.toMatch(/2345|01023456789|010-2345-6789/);
    const row = await db.orderReceiptRequest.findUniqueOrThrow({ where: { id: r.request.id } });
    expect(row.identitySealed).not.toContain("01023456789");
    expect(openBillingKey(row.identitySealed, s.seller.id)).toBe("01023456789");
    expect(await db.auditLog.count({ where: { action: "buyer_receipt_request.create", targetId: r.request.id, actorId: s.buyer.id } })).toBe(1);

    const list = await listSellerReceiptRequests(db, s.ctx);
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({ id: r.request.id, orderNoLabel: expect.stringMatching(/^\d{8}-\d{4,}$/), totalAmount: 10000, issue: { status: "PENDING" } });
    expect(list.counts).toEqual({ PENDING: 1 });
    expect((await listSellerReceiptRequests(db, s.ctx, { status: "FAILED" })).requests).toEqual([]);

    const c = await buyerReceiptContext(db, s.scope, s.bankOrder);
    expect(c).toMatchObject({ canRequest: false, blocked: "active_exists", active: { id: r.request.id } });
  });

  it("세금계산서는 사업자등록번호·사업자 정보가 맞아야 하고, 입금 전 무통장 주문에도 신청할 수 있다", async () => {
    const s = await setup();
    const pending = await newOrder(s.base, null);
    await db.order.update({ where: { id: pending }, data: { paymentMethod: "BANK_TRANSFER" } });
    expect(isBizNo("2208162517")).toBe(true);
    expect(isBizNo("2208162518")).toBe(false);
    const bad = [
      { ...tax, identity: "220-81-62518" },
      { ...tax, taxInfo: undefined },
      { ...tax, taxInfo: { ...tax.taxInfo, email: "no-at" } },
      { ...tax, taxInfo: { ...tax.taxInfo, companyName: "" } },
    ];
    expect((await createReceiptRequest(db, s.scope, pending, bad[0])).ok).toBe(false);
    for (const b of bad.slice(1)) expect(await createReceiptRequest(db, s.scope, pending, b)).toEqual({ ok: false, reason: "invalid_tax_info" });
    expect(await createReceiptRequest(db, s.scope, pending, bad[0])).toEqual({ ok: false, reason: "invalid_identity" });
    const ok = await createReceiptRequest(db, s.scope, pending, tax);
    expect(ok).toMatchObject({ ok: true, request: { kind: "TAX_INVOICE", identityLast4: "2517", taxInfo: tax.taxInfo, issue: { status: "PENDING" } } });
  });

  it("카드 주문·남의 주문·잘못된 값·중복 신청은 거부한다", async () => {
    const s = await setup();
    expect(await createReceiptRequest(db, s.scope, s.cardOrder, income)).toEqual({ ok: false, reason: "not_requestable" });
    expect(await buyerReceiptContext(db, s.scope, s.cardOrder)).toMatchObject({ canRequest: false, blocked: "not_requestable" });
    expect(await createReceiptRequest(db, { ...s.scope, buyerMemberId: s.other.id }, s.bankOrder, income)).toEqual({ ok: false, reason: "not_found" });
    expect(await buyerReceiptContext(db, { ...s.scope, buyerMemberId: s.other.id }, s.bankOrder)).toBeNull();
    expect(await createReceiptRequest(db, s.scope, "x", income)).toEqual({ ok: false, reason: "not_found" });
    expect(await createReceiptRequest(db, s.scope, s.bankOrder, { ...income, kind: "X" })).toEqual({ ok: false, reason: "invalid_kind" });
    for (const identity of ["", "123", "02-1234-5678", "abc", 12345]) {
      expect(await createReceiptRequest(db, s.scope, s.bankOrder, { ...income, identity }), String(identity)).toEqual({ ok: false, reason: "invalid_identity" });
    }
    expect((await createReceiptRequest(db, s.scope, s.bankOrder, income)).ok).toBe(true);
    expect(await createReceiptRequest(db, s.scope, s.bankOrder, income)).toEqual({ ok: false, reason: "active_exists" });
    // 동시에 신청해도 하나만 남는다
    const pending = await newOrder(s.base, null);
    await db.order.update({ where: { id: pending }, data: { paymentMethod: "BANK_TRANSFER" } });
    const both = await Promise.all([createReceiptRequest(db, s.scope, pending, income), createReceiptRequest(db, s.scope, pending, income)]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(await db.orderReceiptRequest.count({ where: { orderId: pending } })).toBe(1);
    // 취소·환불된 주문은 신청할 수 없다(주문 합계에는 배송비가 들어 있다)
    await db.order.update({ where: { id: pending }, data: { status: "CANCELLED" } });
    expect(await createReceiptRequest(db, s.scope, pending, income)).toEqual({ ok: false, reason: "not_requestable" });
    expect((await buyerReceiptContext(db, s.scope, pending))?.blocked).toBe("not_requestable");
  });

  it("철회는 발행 전(대기·실패)만 되고 발행 이력은 취소로 닫히며, 철회 뒤 다시 신청할 수 있다. 발행된 신청은 철회할 수 없다", async () => {
    const s = await setup();
    const r = await createReceiptRequest(db, s.scope, s.bankOrder, income);
    if (!r.ok) throw new Error(r.reason);
    expect(await withdrawReceiptRequest(db, { ...s.scope, buyerMemberId: s.other.id }, r.request.id)).toEqual({ ok: false, reason: "not_found" });
    const w = await withdrawReceiptRequest(db, s.scope, r.request.id);
    expect(w).toMatchObject({ ok: true, request: { issue: { status: "CANCELLED" } } });
    expect(await withdrawReceiptRequest(db, s.scope, r.request.id)).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await db.auditLog.count({ where: { action: "buyer_receipt_request.withdraw", targetId: r.request.id } })).toBe(1);
    const again = await createReceiptRequest(db, s.scope, s.bankOrder, tax);
    if (!again.ok) throw new Error(again.reason);
    await db.receiptIssue.updateMany({ where: { requestId: again.request.id }, data: { status: "ISSUED", issuedAt: new Date() } });
    expect(await withdrawReceiptRequest(db, s.scope, again.request.id)).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("실패·보류한 발행만 다시 시도할 수 있고(대기로) 로그 추적에 남으며, 권한 없는 직원은 막힌다", async () => {
    const s = await setup();
    const r = await createReceiptRequest(db, s.scope, s.bankOrder, income);
    if (!r.ok) throw new Error(r.reason);
    expect(await retryReceiptIssue(db, s.ctx, r.request.id)).toEqual({ ok: false, reason: "invalid_transition" });
    await db.receiptIssue.updateMany({ where: { requestId: r.request.id }, data: { status: "FAILED", failureCode: "X1", attempts: 1 } });
    expect((await listSellerReceiptRequests(db, s.ctx, { status: "FAILED" })).requests[0].issue).toMatchObject({ status: "FAILED", failureCode: "X1" });
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const staffCtx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(retryReceiptIssue(db, staffCtx, r.request.id)).rejects.toThrow();
    await expect(listSellerReceiptRequests(db, staffCtx)).rejects.toThrow();
    const ok = await retryReceiptIssue(db, s.ctx, r.request.id);
    expect(ok).toMatchObject({ ok: true, request: { issue: { status: "PENDING", failureCode: null, attempts: 1 } } });
    expect(await db.auditLog.count({ where: { action: "receipt_issue.retry", targetId: r.request.id, actorId: s.owner.id } })).toBe(1);
    expect(await retryReceiptIssue(db, s.ctx, "nope")).toEqual({ ok: false, reason: "not_found" });
    // 충전금 잔액이 모자라 보류한 발행도 다시 시도하면 대기로 돌아오고, 구매자는 보류 중에도 철회할 수 있다
    await db.receiptIssue.updateMany({ where: { requestId: r.request.id }, data: { status: "ON_HOLD" } });
    expect((await listSellerReceiptRequests(db, s.ctx, { status: "ON_HOLD" })).counts).toEqual({ ON_HOLD: 1 });
    expect(await retryReceiptIssue(db, s.ctx, r.request.id)).toMatchObject({ ok: true, request: { issue: { status: "PENDING" } } });
    await db.receiptIssue.updateMany({ where: { requestId: r.request.id }, data: { status: "ON_HOLD" } });
    expect(await withdrawReceiptRequest(db, s.scope, r.request.id)).toMatchObject({ ok: true, request: { issue: { status: "CANCELLED" } } });
  });

  it("경로: 구매자 신청 201·거부 문구(해요체), 철회, 파트너스 목록·다시 시도(합니다체)", async () => {
    const s = await setup();
    const bl = await loginBuyer(db, { sellerId: s.seller.id, loginId: s.buyer.loginId, password: PASSWORD }, {});
    const sl = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!bl.ok || !sl.ok) throw new Error("login");
    const bc = `lo_buyer=${bl.token}`;
    const sc = `lo_seller=${sl.token}`;
    const slugCtx = { params: Promise.resolve({ slug: s.seller.slug }) };
    const url = `http://localhost:3000/api/shop/${s.seller.slug}/receipt-requests`;
    const post = (body: unknown) => buyerPostRoute(new Request(url, { method: "POST", headers: { ...H, cookie: bc }, body: JSON.stringify(body) }), slugCtx);
    const bad = await post({ ...income, orderId: s.bankOrder, identity: "1" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_identity", message: BUYER_RECEIPT_MESSAGES.invalid_identity });
    const card = await post({ ...income, orderId: s.cardOrder });
    expect(card.status).toBe(409);
    expect(await card.json()).toEqual({ error: "not_requestable", message: BUYER_RECEIPT_MESSAGES.not_requestable });
    const ok = await post({ ...income, orderId: s.bankOrder });
    expect(ok.status).toBe(201);
    const { request } = await ok.json();
    const got = await buyerGetRoute(new Request(`${url}?orderId=${s.bankOrder}`, { headers: { ...H, cookie: bc } }), slugCtx);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toMatchObject({ canRequest: false, blocked: "active_exists", active: { id: request.id } });

    const list = await sellerListRoute(new Request("http://localhost:3000/api/seller/receipt-requests", { headers: { ...H, cookie: sc } }));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ requests: [{ id: request.id, issue: { status: "PENDING" } }], counts: { PENDING: 1 } });
    const idCtx = { params: Promise.resolve({ id: request.id }) };
    const retry = await retryRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: sc }, body: "{}" }), idCtx);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "invalid_transition", message: SELLER_RECEIPT_MESSAGES.invalid_transition });
    const wd = await withdrawRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: bc }, body: "{}" }), { params: Promise.resolve({ slug: s.seller.slug, id: request.id }) });
    expect(wd.status).toBe(200);
    expect(await wd.json()).toMatchObject({ request: { issue: { status: "CANCELLED" } } });
  });
});

describe("쇼핑몰 운영 상태와 현금영수증 신청(대표님 결정 2026-10-06)", () => {
  it("준비 중·일시 정지에서도 이미 낸 주문의 신청은 받고, 이용 정지 중에는 기존대로 막는다", async () => {
    const s = await setup();
    await db.seller.update({ where: { id: s.seller.id }, data: { operatingState: "PAUSED" } });
    expect((await buyerReceiptContext(db, s.scope, s.bankOrder))?.blocked).toBeNull();
    expect((await createReceiptRequest(db, s.scope, s.bankOrder, { ...income, orderId: s.bankOrder })).ok).toBe(true);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await buyerReceiptContext(db, s.scope, s.cardOrder))?.blocked).toBe("shop_unavailable");
  });
});

