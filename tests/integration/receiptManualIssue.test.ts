import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as bulkRoute } from "../../app/api/seller/receipt-requests/complete/route";
import { GET as exportRoute } from "../../app/api/seller/receipt-requests/export/route";
import { GET as listRoute } from "../../app/api/seller/receipt-requests/route";
import { POST as completeRoute } from "../../app/api/seller/receipt-requests/[id]/complete/route";
import { GET as settingGet, PUT as settingPut } from "../../app/api/seller/receipt-setting/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid } from "../../lib/server/queue/service";
import { completeReceiptIssue, completeReceiptIssues, exportSellerReceiptRequests, getSellerReceiptRequest, readReceiptSetting, receiptMonthRange, saveReceiptSetting } from "../../lib/server/receipts/manual";
import { createReceiptRequest, listSellerReceiptRequests, receiptFilterValid } from "../../lib/server/receipts/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 직접 발행 후 완료 처리·검색 조건·요약·내려받기·발행 방식(SA-024 정본 v320).
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
  const product = await db.product.create({ data: { sellerId: seller.id, name: "박스", price: 7000, status: "ON_SALE" } });
  const opt = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1개", stock: 50 } });
  const base = { sellerId: seller.id, buyerId: buyer.id, optionId: opt.id };
  const scope = { sellerId: seller.id, buyerMemberId: buyer.id };
  return { seller, owner, ctx, buyer, base, scope };
}
type S = Awaited<ReturnType<typeof setup>>;
const income = { kind: "CASH_RECEIPT_INCOME", identity: "010-2345-6789" };
const tax = { kind: "TAX_INVOICE", identity: BIZ, taxInfo: { companyName: "주식회사 테스트", representative: "홍길동", email: "tax@example.com" } };
async function request(s: S, body: Record<string, unknown>, method: "BANK_TRANSFER" | null = "BANK_TRANSFER") {
  const orderId = await newOrder(s.base, method);
  if (!method) await db.order.update({ where: { id: orderId }, data: { paymentMethod: "BANK_TRANSFER" } });
  const r = await createReceiptRequest(db, s.scope, orderId, body);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.request.id, orderId };
}

describe("발행 완료 처리", () => {
  it("발행 대기를 발행 완료로 닫고(직접 발행이라 충전금 차감 대상 아님) 구매자 안내 기록·로그 추적을 남긴다. 두 번째는 거부", async () => {
    const s = await setup();
    const r = await request(s, income);
    const done = await completeReceiptIssue(db, s.ctx, r.id);
    expect(done).toMatchObject({ ok: true, request: { issue: { status: "ISSUED", chargeable: false, issuedAt: expect.any(Date) } } });
    expect(await db.orderNotification.count({ where: { orderId: r.orderId, kind: "RECEIPT_ISSUED", status: "PENDING" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "receipt_issue.complete", targetId: r.id, actorId: s.owner.id } })).toBe(1);
    expect(await completeReceiptIssue(db, s.ctx, r.id)).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await completeReceiptIssue(db, s.ctx, "nope")).toEqual({ ok: false, reason: "not_found" });
  });

  it("입금 확인 전 주문·실패 상태·철회한 신청은 처리할 수 없고, RECEIPT_TAX 권한이 없는 직원은 막힌다", async () => {
    const s = await setup();
    const unpaid = await request(s, income, null);
    expect(await completeReceiptIssue(db, s.ctx, unpaid.id)).toEqual({ ok: false, reason: "not_paid" });
    const failed = await request(s, income);
    await db.receiptIssue.updateMany({ where: { requestId: failed.id }, data: { status: "FAILED", failureCode: "X1" } });
    expect(await completeReceiptIssue(db, s.ctx, failed.id)).toEqual({ ok: false, reason: "invalid_transition" });
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const staffCtx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(completeReceiptIssue(db, staffCtx, failed.id)).rejects.toThrow();
    // 다른 쇼핑몰은 못 건드린다
    const other = await setup();
    expect(await completeReceiptIssue(db, other.ctx, unpaid.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("선택 발행 완료 처리는 건마다 결과를 돌려주고, 비었거나 51건 이상이면 거부한다", async () => {
    const s = await setup();
    const a = await request(s, income);
    const b = await request(s, tax);
    const c = await request(s, income, null);
    const r = await completeReceiptIssues(db, s.ctx, [a.id, b.id, c.id, a.id]);
    expect(r).toEqual({
      ok: true,
      completed: 2,
      results: [
        { id: a.id, ok: true },
        { id: b.id, ok: true },
        { id: c.id, ok: false, reason: "not_paid" },
      ],
    });
    expect(await completeReceiptIssues(db, s.ctx, [])).toEqual({ ok: false });
    expect(await completeReceiptIssues(db, s.ctx, Array.from({ length: 51 }, () => a.id))).toEqual({ ok: false });
  });
});

describe("검색 조건·요약·상세·내려받기", () => {
  it("종류·상태·기간·검색어(닉네임·번호 뒤 4자리)로 거르고, 요약은 대기·완료(이번 달) 건수·금액을 준다", async () => {
    const s = await setup();
    const a = await request(s, income); // 소득공제 6789
    const b = await request(s, tax); // 세금계산서 2517 끝
    await request(s, { kind: "CASH_RECEIPT_EXPENSE", identity: BIZ });
    await completeReceiptIssue(db, s.ctx, b.id);
    const all = await listSellerReceiptRequests(db, s.ctx);
    expect(all.requests).toHaveLength(3);
    expect(all.summary).toEqual({ pending: 2, failed: 0, cancelled: 0, issuedThisMonth: 1, issuedAmountThisMonth: 10000 });
    const ids = async (q: Parameters<typeof listSellerReceiptRequests>[2]) => (await listSellerReceiptRequests(db, s.ctx, q)).requests.map((r) => r.id).sort();
    expect(await ids({ kind: "CASH_RECEIPT" })).toHaveLength(2);
    expect(await ids({ kind: "TAX_INVOICE" })).toEqual([b.id]);
    expect(await ids({ status: "ISSUED" })).toEqual([b.id]);
    expect(await ids({ q: "010-2345-6789" })).toEqual([a.id]);
    expect(await ids({ field: "phone", q: "6789" })).toEqual([a.id]);
    expect(await ids({ field: "bizno", q: "2517" })).toHaveLength(2);
    expect(await ids({ field: "phone", q: "12" })).toEqual([]);
    const nick = all.requests[0].nickname;
    expect(await ids({ field: "nickname", q: nick.slice(0, 2) })).toHaveLength(3);
    expect(await ids({ field: "nickname", q: "없는닉네임" })).toEqual([]);
    expect(await ids({ from: "2000-01-01", to: "2000-01-31" })).toEqual([]);
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    expect(await ids({ from: today, to: today })).toHaveLength(3);
    expect(receiptFilterValid({ from: "2026-13-01" })).toBe(false);
    expect(receiptFilterValid({ from: "2026-10-05", to: "2026-10-01" })).toBe(false);
    expect(receiptFilterValid({ field: "x" })).toBe(false);
    expect(receiptFilterValid({ from: today, field: "phone", q: "1234" })).toBe(true);
  });

  it("상세는 직접 발행에 필요한 번호 전체를 열고 로그 추적에 남긴다", async () => {
    const s = await setup();
    const r = await request(s, tax);
    const d = await getSellerReceiptRequest(db, s.ctx, r.id);
    expect(d).toMatchObject({ identity: "2208162517", identityLast4: "2517", taxInfo: { companyName: "주식회사 테스트", email: "tax@example.com" }, order: { status: "PAID" } });
    expect(await db.auditLog.count({ where: { action: "receipt_request.reveal_identity", targetId: r.id } })).toBe(1);
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    await expect(getSellerReceiptRequest(db, { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] }, r.id)).rejects.toThrow();
    expect(await getSellerReceiptRequest(db, s.ctx, "nope")).toBeNull();
  });

  it("내려받기는 같은 조건의 CSV(번호 뒤 4자리만)를 만들고 로그 추적에 남긴다", async () => {
    const s = await setup();
    const r = await request(s, income);
    await completeReceiptIssue(db, s.ctx, r.id);
    await request(s, tax);
    const month = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
    const out = await exportSellerReceiptRequests(db, s.ctx, { month, status: "ISSUED" });
    if (!out.ok) throw new Error("export");
    const lines = out.csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("접수 시각,닉네임,주문번호,종류,번호(뒤 4자리),금액,상태,발행 시각");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("현금영수증 · 소득공제");
    expect(lines[1]).toContain("****6789");
    expect(lines[1]).toContain("발행 완료");
    expect(out.csv).not.toContain("2345");
    expect(await db.auditLog.count({ where: { action: "receipt_request.export", actorId: s.owner.id } })).toBe(1);
    expect(await exportSellerReceiptRequests(db, s.ctx, { month: "2026-13" })).toEqual({ ok: false });
    expect(receiptMonthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(receiptMonthRange("26-2")).toBeNull();
  });
});

describe("발행 방식", () => {
  it("기본은 직접 발행, 자동 발행은 준비 중이라 저장할 수 없고 모르는 값은 거부한다", async () => {
    const s = await setup();
    expect(await readReceiptSetting(db, s.ctx)).toEqual({ issueMode: "DIRECT" });
    expect(await saveReceiptSetting(db, s.ctx, { issueMode: "AUTO" })).toEqual({ ok: false, reason: "auto_unavailable" });
    expect(await saveReceiptSetting(db, s.ctx, { issueMode: "X" })).toEqual({ ok: false, reason: "invalid_mode" });
    expect(await saveReceiptSetting(db, s.ctx, { issueMode: "DIRECT" })).toEqual({ ok: true, issueMode: "DIRECT" });
    expect(await readReceiptSetting(db, s.ctx)).toEqual({ issueMode: "DIRECT" });
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    await expect(saveReceiptSetting(db, { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] }, { issueMode: "DIRECT" })).rejects.toThrow();
  });
});

describe("경로", () => {
  it("목록 필터·요약(400 검사), 발행 완료 처리·선택 처리, 내려받기, 발행 방식", async () => {
    const s = await setup();
    const sl = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!sl.ok) throw new Error("login");
    const sc = `lo_seller=${sl.token}`;
    const a = await request(s, income);
    const b = await request(s, tax);
    const get = (path: string, route: (r: Request) => Promise<Response>) => route(new Request(`http://localhost:3000/api/seller/${path}`, { headers: { ...H, cookie: sc } }));
    const bad = await get("receipt-requests?from=2026-99-99", listRoute);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_filter" });
    const list = await get("receipt-requests?kind=TAX_INVOICE", listRoute);
    expect(await list.json()).toMatchObject({ requests: [{ id: b.id }], summary: { pending: 2, issuedThisMonth: 0, issuedAmountThisMonth: 0 } });

    const post = (path: string, body: unknown, route: (r: Request, c: never) => Promise<Response>, ctxArg?: unknown) =>
      route(new Request(`http://localhost:3000/api/seller/${path}`, { method: "POST", headers: { ...H, cookie: sc }, body: JSON.stringify(body) }), ctxArg as never);
    const one = await post("x", {}, completeRoute, { params: Promise.resolve({ id: a.id }) });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ request: { issue: { status: "ISSUED" } } });
    const again = await post("x", {}, completeRoute, { params: Promise.resolve({ id: a.id }) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "invalid_transition" });
    const many = await post("receipt-requests/complete", { ids: [b.id, a.id] }, bulkRoute);
    expect(await many.json()).toEqual({ completed: 1, results: [{ id: b.id, ok: true }, { id: a.id, ok: false, reason: "invalid_transition" }] });
    expect((await post("receipt-requests/complete", { ids: [] }, bulkRoute)).status).toBe(400);

    const csv = await get("receipt-requests/export?status=ISSUED", exportRoute);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("receipts-");
    expect((await get("receipt-requests/export?month=bad", exportRoute)).status).toBe(400);

    expect(await (await get("receipt-setting", settingGet)).json()).toEqual({ issueMode: "DIRECT" });
    const put = (body: unknown) => settingPut(new Request("http://localhost:3000/api/seller/receipt-setting", { method: "PUT", headers: { ...H, cookie: sc }, body: JSON.stringify(body) }));
    const auto = await put({ issueMode: "AUTO" });
    expect(auto.status).toBe(409);
    expect(await auto.json()).toEqual({ error: "auto_unavailable", message: "자동 발행은 준비 중입니다" });
    expect((await put({ issueMode: "Z" })).status).toBe(400);
    expect((await put({ issueMode: "DIRECT" })).status).toBe(200);
  });
});
