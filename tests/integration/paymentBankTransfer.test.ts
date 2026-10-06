import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as bankTransferRoute } from "../../app/api/shop/[slug]/payments/bank-transfer/route";
import { GET as getAccountRoute, PUT as putAccountRoute } from "../../app/api/seller/payments/bank-account/route";
import { GET as depositsRoute } from "../../app/api/seller/payments/deposits/route";
import { POST as confirmRoute } from "../../app/api/seller/payments/deposits/confirm/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { FakePaymentGateway } from "../../lib/server/payments/gateway";
import { chooseBankTransfer, confirmDeposits, listPendingDeposits, saveBankAccount } from "../../lib/server/payments/bank";
import { BANK_TRANSFER_MESSAGES } from "../../lib/server/payments/messages";
import { confirmAuthResult, reconcilePayment, startPayment } from "../../lib/server/payments/service";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const ACCOUNT = { bankName: "국민은행", accountNumber: "123-456-789012", accountHolder: "쇼핑몰 대표" };
const origin = "http://localhost:3000";
const jsonReq = (url: string, method: string, cookie: string, body?: unknown) =>
  new Request(`${origin}${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000", origin, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// 품목 5,000원 × 2 + 배송비 3,000원 = 13,000원
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  let orderNo = 0;
  async function order(opts: { buyerMemberId?: string; due?: Date | null } = {}) {
    const o = await db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: ++orderNo,
        buyerMemberId: opts.buyerMemberId ?? buyer.id,
        broadcastNicknameSnapshot: "닉",
        shippingFee: 3000,
        totalAmount: 13000,
        paymentDueAt: opts.due === undefined ? new Date(Date.now() + 24 * 3600_000) : opts.due,
      },
    });
    const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 10 } });
    await db.orderItem.create({
      data: { sellerId: seller.id, orderId: o.id, productId: product.id, optionId: option.id, productNameSnapshot: "부스터 팩", optionNameSnapshot: "1팩", unitPrice: 5000, quantity: 2 },
    });
    return o;
  }
  const sellerCookie = async (email: string) => {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  const buyerCookie = async (loginId: string) => {
    const r = await loginBuyer(db, { sellerId: seller.id, loginId, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_buyer=${r.token}`;
  };
  return { seller, grade, owner, ctx, buyer, order, sellerCookie, buyerCookie };
}

const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
const orderOf = (id: string) => db.order.findUniqueOrThrow({ where: { id } });

describe("입금 계좌", () => {
  it("대표자가 저장·조회하고, 로그 추적에는 끝 4자리만 남긴다", async () => {
    const s = await setup();
    const cookie = await s.sellerCookie(s.owner.email);
    expect(await (await getAccountRoute(jsonReq("/api/seller/payments/bank-account", "GET", cookie))).json()).toEqual({ account: null });
    const bad = await putAccountRoute(jsonReq("/api/seller/payments/bank-account", "PUT", cookie, { ...ACCOUNT, accountNumber: "12a-34" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_bank_account");
    const ok = await putAccountRoute(jsonReq("/api/seller/payments/bank-account", "PUT", cookie, { ...ACCOUNT, bankName: "  국민은행 " }));
    expect(await ok.json()).toEqual({ account: ACCOUNT });
    expect(await (await getAccountRoute(jsonReq("/api/seller/payments/bank-account", "GET", cookie))).json()).toEqual({ account: ACCOUNT });
    const log = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "seller.bank_account.update", sellerId: s.seller.id } });
    expect(JSON.stringify(log)).not.toContain("789012");
    expect(log.after).toMatchObject({ accountNumber: "****9012" });
  });

  it("SHOP_SETTINGS 권한이 없는 직원은 바꿀 수 없고, 다른 쇼핑몰 계좌는 보이지 않는다", async () => {
    const s = await setup();
    const staff = await createSellerUser(s.seller.id, "MANAGER");
    const cookie = await s.sellerCookie(staff.email);
    expect((await putAccountRoute(jsonReq("/api/seller/payments/bank-account", "PUT", cookie, ACCOUNT))).status).toBe(403);
    await saveBankAccount(db, s.ctx, ACCOUNT);
    const t = await setup();
    expect(await (await getAccountRoute(jsonReq("/api/seller/payments/bank-account", "GET", await t.sellerCookie(t.owner.email)))).json()).toEqual({ account: null });
  });
});

describe("구매자 무통장 입금 선택", () => {
  it("계좌가 없으면 409 안내, 있으면 계좌·금액·주문할 때 정한 기한을 주고 다시 골라도 기한은 그대로", async () => {
    const s = await setup();
    const o = await s.order();
    const cookie = await s.buyerCookie(s.buyer.loginId);
    const call = (orderId: string) =>
      bankTransferRoute(jsonReq(`/api/shop/${s.seller.slug}/payments/bank-transfer`, "POST", cookie, { orderId }), { params: Promise.resolve({ slug: s.seller.slug }) });
    const missing = await call(o.id);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "bank_account_missing", message: BANK_TRANSFER_MESSAGES.bank_account_missing });
    await saveBankAccount(db, s.ctx, ACCOUNT);
    const res = await call(o.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ orderId: o.id, amount: 13000, ...ACCOUNT, paymentDueAt: o.paymentDueAt!.toISOString() });
    expect((await orderOf(o.id)).paymentMethod).toBe("BANK_TRANSFER");
    await call(o.id);
    expect((await orderOf(o.id)).paymentDueAt).toEqual(o.paymentDueAt);
    expect(await db.auditLog.count({ where: { action: "order.payment_method", targetId: o.id } })).toBe(1);
  });

  it("다른 구매자 주문은 404, 기한 지난 주문은 거절, 카드 결제가 승인 중이면 already_paid", async () => {
    const s = await setup();
    await saveBankAccount(db, s.ctx, ACCOUNT);
    const other = await createLoginBuyer(s.seller.id, s.grade.id);
    const o = await s.order();
    expect(await chooseBankTransfer(db, { sellerId: s.seller.id, buyerMemberId: other.id, orderId: o.id })).toEqual({ ok: false, reason: "not_found" });
    const late = await s.order({ due: new Date(Date.now() - 1000) });
    expect(await chooseBankTransfer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: late.id })).toEqual({ ok: false, reason: "order_not_payable" });
    await db.payment.create({ data: { sellerId: s.seller.id, orderId: o.id, provider: "fake", method: "CARD", amount: 13000, status: "APPROVING", pgTid: "t-approving" } });
    expect(await chooseBankTransfer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id })).toEqual({ ok: false, reason: "already_paid" });
  });
});

describe("판매자 입금 대기·입금 확인", () => {
  it("정본 상태·KST 기간·요약은 테넌트/분리 보관 경계를 지킨다", async () => {
    const s = await setup();
    const other = await setup();
    const now = new Date("2026-10-06T00:30:00Z");
    const start = new Date("2026-10-05T15:00:00Z");
    const end = new Date("2026-10-06T14:59:59.999Z");
    const create = async (change: Parameters<typeof db.order.update>[0]["data"], tenant = s) => {
      const o = await tenant.order();
      return db.order.update({ where: { id: o.id }, data: { paymentMethod: "BANK_TRANSFER", createdAt: start, ...change } });
    };
    const pending = await create({ paymentDueAt: new Date(now.getTime() + 3600_000) });
    const overdue = await create({ paymentDueAt: now });
    const paid = await create({ status: "PAID", paidAt: start, createdAt: end });
    const cancelled = await create({ status: "CANCELLED", autoCancelledAt: end });
    await create({ status: "CANCELLED", autoCancelledAt: null }); // 수동 취소 제외
    await create({ status: "PAID", paidAt: now, paymentMethod: "CARD" });
    await create({ status: "PAID", paidAt: now, legalHoldAt: now });
    await create({ status: "PAID", paidAt: now }, other);
    await create({ createdAt: new Date("2026-10-06T15:00:00Z"), paymentDueAt: null });
    const r = await listPendingDeposits(db, s.ctx, { status: "ALL", from: "2026-10-06", to: "2026-10-06" }, now);
    if (!r.ok) throw new Error();
    expect(new Set(r.value.deposits.map((d) => d.orderId))).toEqual(new Set([pending.id, overdue.id, paid.id, cancelled.id]));
    expect(r.value.total).toBe(4);
    expect(r.value.summary).toEqual({ pendingCount: 2, pendingAmount: 26000, dueWithinHourCount: 1, confirmedTodayCount: 1, overdueCount: 1, autoCancelledTodayCount: 1 });
    const late = await listPendingDeposits(db, s.ctx, { status: "OVERDUE" }, now);
    expect(late.ok && late.value.deposits.map((d) => d.orderId)).toEqual([overdue.id]);
    const page = await listPendingDeposits(db, s.ctx, { status: "ALL", offset: "5", limit: "1" }, now);
    expect(page.ok && page.value.deposits).toEqual([]);
    expect(page.ok && page.value.total).toBe(5);
  });

  it("정규화 검색과 개인정보 권한은 전체 상태에서도 유지된다", async () => {
    const s = await setup();
    const o = await s.order();
    await db.order.update({ where: { id: o.id }, data: { broadcastNicknameSnapshot: "ABC", paymentMethod: "BANK_TRANSFER" } });
    const buyer = await listPendingDeposits(db, s.ctx, { status: "ALL", searchBy: "buyer", q: "  ＡＢＣ  " });
    expect(buyer.ok && buyer.value.deposits.map((d) => d.orderId)).toEqual([o.id]);
    const amount = await listPendingDeposits(db, s.ctx, { status: "ALL", searchBy: "amount", q: " １３，０００원 " });
    expect(amount.ok && amount.value.total).toBe(1);
    const noPii: TenantContext = { ...s.ctx, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(listPendingDeposits(db, noPii, { status: "ALL", searchBy: "depositor", q: s.buyer.name })).rejects.toMatchObject({ status: 403 });
    const visible = await listPendingDeposits(db, noPii, { status: "ALL", searchBy: "buyer", q: "ABC" });
    expect(visible.ok && visible.value.deposits[0]).not.toHaveProperty("depositorName");
  });

  it("조회 route는 필터 오류 400과 PII 검색 거부 403을 no-store로 반환한다", async () => {
    const s = await setup();
    const cookie = await s.sellerCookie(s.owner.email);
    const response = await depositsRoute(jsonReq("/api/seller/payments/deposits?status=ALL&from=2026-02-30", "GET", cookie));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const staffCookie = await s.sellerCookie(staff.email);
    const denied = await depositsRoute(jsonReq("/api/seller/payments/deposits?status=ALL&searchBy=depositor&q=test", "GET", staffCookie));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toContain("no-store");
  });

  it("목록은 이 쇼핑몰의 결제 대기 주문만(카드 승인 중·완료 제외), 기한 빠른 순, 입금자 이름은 개인정보 권한이 있을 때만", async () => {
    const s = await setup();
    const t = await setup();
    await t.order();
    const later = await s.order({ due: new Date(Date.now() + 48 * 3600_000) });
    const sooner = await s.order({ due: new Date(Date.now() + 1 * 3600_000) });
    const noDue = await s.order({ due: null });
    const carding = await s.order();
    await db.payment.create({ data: { sellerId: s.seller.id, orderId: carding.id, provider: "fake", method: "CARD", amount: 13000, status: "APPROVING", pgTid: "t1" } });
    const r = await listPendingDeposits(db, s.ctx, {});
    if (!r.ok) throw new Error();
    expect(r.value.total).toBe(3);
    expect(r.value.deposits.map((d) => d.orderId)).toEqual([sooner.id, later.id, noDue.id]);
    expect(r.value.deposits[0]).toMatchObject({ orderNoLabel: expect.stringMatching(/^\d{8}-\d{4,}$/), amount: 13000, nickname: "닉", depositorName: s.buyer.name });
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", reason: "pending_deposits" } })).toBe(1);

    const noPii: TenantContext = { ...s.ctx, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    const r2 = await listPendingDeposits(db, noPii, { limit: "1", offset: "1" });
    if (!r2.ok) throw new Error();
    expect(r2.value.deposits).toHaveLength(1);
    expect(r2.value.deposits[0].orderId).toBe(later.id);
    expect(r2.value.deposits[0]).not.toHaveProperty("depositorName");
    expect((await listPendingDeposits(db, s.ctx, { limit: "51" })).ok).toBe(false);
  });

  it("입금 확인: 결제 완료(무통장)·주문대기 생성, 다시 보내면 already_paid, 다른 쇼핑몰 주문은 not_found", async () => {
    const s = await setup();
    const t = await setup();
    const foreign = await t.order();
    const a = await s.order();
    const b = await s.order();
    const cookie = await s.sellerCookie(s.owner.email);
    const call = async (orderIds: unknown, expectedVersion?: number) =>
      confirmRoute(jsonReq("/api/seller/payments/deposits/confirm", "POST", cookie, { orderIds, expectedVersion: expectedVersion ?? (await lv(s.seller.id)) }));
    const res = await call([a.id, b.id, foreign.id, a.id]);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([
      { orderId: a.id, result: "paid" },
      { orderId: b.id, result: "paid" },
      { orderId: foreign.id, result: "not_found" },
    ]);
    expect(await orderOf(a.id)).toMatchObject({ status: "PAID", paymentMethod: "BANK_TRANSFER" });
    expect(await orderOf(foreign.id)).toMatchObject({ status: "PENDING_PAYMENT" });
    expect(await db.queueItem.count({ where: { orderId: a.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "order.deposit_confirm", targetId: a.id, actorId: s.owner.id } })).toBe(1);
    expect((await (await call([a.id])).json()).results).toEqual([{ orderId: a.id, result: "already_paid" }]);
    expect(await db.queueItem.count({ where: { orderId: a.id } })).toBe(1);
  });

  it("버전이 다르면 409로 아무것도 바꾸지 않고, 값이 틀리면 400, 권한 없는 직원은 403", async () => {
    const s = await setup();
    const o = await s.order();
    const cookie = await s.sellerCookie(s.owner.email);
    const res = await confirmRoute(jsonReq("/api/seller/payments/deposits/confirm", "POST", cookie, { orderIds: [o.id], expectedVersion: (await lv(s.seller.id)) + 5 }));
    expect(res.status).toBe(409);
    expect((await orderOf(o.id)).status).toBe("PENDING_PAYMENT");
    expect((await confirmRoute(jsonReq("/api/seller/payments/deposits/confirm", "POST", cookie, { orderIds: [], expectedVersion: 0 }))).status).toBe(400);
    expect((await confirmRoute(jsonReq("/api/seller/payments/deposits/confirm", "POST", cookie, { orderIds: ["x"], expectedVersion: 0 }))).status).toBe(400);
    const caster = await createSellerUser(s.seller.id, "BROADCASTER");
    const res2 = await confirmRoute(jsonReq("/api/seller/payments/deposits/confirm", "POST", await s.sellerCookie(caster.email), { orderIds: [o.id], expectedVersion: await lv(s.seller.id) }));
    expect(res2.status).toBe(403);
    expect((await depositsRoute(jsonReq("/api/seller/payments/deposits", "GET", await s.sellerCookie(caster.email)))).status).toBe(403);
  });

  it("같은 주문을 동시에 두 번 확인해도 결제 완료는 한 번", async () => {
    const s = await setup();
    const o = await s.order();
    const v = await lv(s.seller.id);
    const [r1, r2] = await Promise.all([confirmDeposits(db, s.ctx, { orderIds: [o.id], expectedVersion: v }), confirmDeposits(db, s.ctx, { orderIds: [o.id], expectedVersion: v })]);
    const results = [r1, r2].flatMap((r) => (r.ok ? r.results : []));
    expect(results.filter((x) => x.result === "paid")).toHaveLength(1);
    expect(await db.queueItem.count({ where: { orderId: o.id } })).toBe(1);
    expect(await db.orderStatusHistory.count({ where: { orderId: o.id, toStatus: "PAID" } })).toBe(1);
  });
});

describe("카드·무통장 이중 결제 방지", () => {
  it("카드 결제가 승인 중이면 입금 확인을 막는다(card_in_progress)", async () => {
    const s = await setup();
    const o = await s.order();
    await db.payment.create({ data: { sellerId: s.seller.id, orderId: o.id, provider: "fake", method: "CARD", amount: 13000, status: "APPROVING", pgTid: "t2" } });
    const r = await confirmDeposits(db, s.ctx, { orderIds: [o.id], expectedVersion: await lv(s.seller.id) });
    expect(r).toEqual({ ok: true, results: [{ orderId: o.id, result: "card_in_progress" }] });
  });

  it("입금 확인은 열려 있던 카드 결제 창을 닫고, 그 창으로 인증해도 승인하지 않는다", async () => {
    const s = await setup();
    const gw = new FakePaymentGateway();
    const o = await s.order();
    const p = await startPayment(db, gw, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id });
    if (!p.ok) throw new Error(p.reason);
    await confirmDeposits(db, s.ctx, { orderIds: [o.id], expectedVersion: await lv(s.seller.id) });
    expect(await confirmAuthResult(db, gw, gw.authorize(p.orderId, 13000))).toMatchObject({ ok: true, outcome: "failed" });
    expect(gw.approveCalls).toBe(0);
    expect(await db.payment.findUniqueOrThrow({ where: { id: p.paymentId } })).toMatchObject({ status: "FAILED", failureCode: "superseded_by_deposit" });
    expect(await orderOf(o.id)).toMatchObject({ status: "PAID", paymentMethod: "BANK_TRANSFER" });
  });

  it("카드 승인 결과를 모르는 사이 입금 확인이 먼저 되면, 나중에 확정된 카드 결제는 전액 취소한다", async () => {
    const s = await setup();
    const gw = new FakePaymentGateway();
    const o = await s.order();
    const p = await startPayment(db, gw, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id });
    if (!p.ok) throw new Error(p.reason);
    gw.failNext = "timeout_after";
    gw.netCancel = async () => ({ kind: "unknown", error: "timeout" });
    await confirmAuthResult(db, gw, gw.authorize(p.orderId, 13000));
    // 판매자 확인과 카드 승인이 겹친 경우(확인 화면 검사를 지난 뒤 승인이 잡힘)를 그대로 만든다
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id, paymentMethod: "BANK_TRANSFER" });
    expect(await reconcilePayment(db, gw, p.paymentId)).toBe("cancelled");
    expect(await db.payment.findUniqueOrThrow({ where: { id: p.paymentId } })).toMatchObject({ status: "CANCELLED", cancelledAmount: 13000 });
    expect(gw.payments.get(`fake-tid-${p.paymentId}`)).toMatchObject({ status: "cancelled", balanceAmt: 0 });
    expect(await orderOf(o.id)).toMatchObject({ status: "PAID", paymentMethod: "BANK_TRANSFER", pgTxId: null });
    expect(await db.queueItem.count({ where: { orderId: o.id } })).toBe(1);
  });
});
