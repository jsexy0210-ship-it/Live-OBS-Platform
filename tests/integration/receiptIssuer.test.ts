import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as issuerGet, PUT as issuerPut } from "../../app/api/seller/receipt-issuer/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { readReceiptIssuer, saveReceiptIssuer } from "../../lib/server/receipts/issuer";
import { processReceiptIssue, type ReceiptProvider } from "../../lib/server/receipts/provider";
import { createReceiptRequest } from "../../lib/server/receipts/service";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 명의 영수증 발행자 정보와 발행 업체 연동 인터페이스(SA-024, 대표님 결정 2026-10-05): 정보 저장·인증서 상태, 업체가 없으면 대기 유지.
beforeEach(() => {
  vi.stubEnv("BILLING_KEY_SECRET", "test-billing-key-secret-0123456789abcdef");
  return resetDb();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };
const BIZ = "220-81-62517";
const issuerBody = { businessNumber: BIZ, companyName: "시험 주식회사", representative: "홍길동" };

async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "박스", price: 7000, status: "ON_SALE" } });
  const opt = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1개", stock: 50 } });
  const o = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: opt.id, quantity: 1 }], consent, shippingAddress: addr });
  if (!o.ok) throw new Error(o.reason);
  const paid = await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "BANK_TRANSFER" });
  if (!paid.ok) throw new Error(paid.reason);
  return { seller, owner, ctx, buyer, orderId: o.orderId, scope: { sellerId: seller.id, buyerMemberId: buyer.id } };
}
type S = Awaited<ReturnType<typeof setup>>;
async function newIssue(s: S, body: Record<string, unknown> = { kind: "CASH_RECEIPT_INCOME", identity: "010-2345-6789" }) {
  const r = await createReceiptRequest(db, s.scope, s.orderId, body);
  if (!r.ok) throw new Error(r.reason);
  return r.request.issue!.id;
}
const issueRow = (id: string) => db.receiptIssue.findUniqueOrThrow({ where: { id } });
const registerIssuer = async (s: S) => {
  await saveReceiptIssuer(db, s.ctx, issuerBody);
  await db.sellerReceiptIssuer.update({ where: { sellerId: s.seller.id }, data: { certStatus: "REGISTERED", certCheckedAt: new Date() } });
};

describe("영수증 발행자 정보", () => {
  it("저장하면 사업자번호를 하이픈 형식으로 돌려주고 인증서는 미등록으로 시작하며, 로그 추적에 남는다", async () => {
    const s = await setup();
    expect(await readReceiptIssuer(db, s.ctx)).toBeNull();
    const saved = await saveReceiptIssuer(db, s.ctx, { ...issuerBody, businessNumber: "2208162517" });
    expect(saved).toMatchObject({ ok: true, issuer: { businessNumber: BIZ, companyName: "시험 주식회사", representative: "홍길동", certStatus: "NOT_REGISTERED", certCheckedAt: null } });
    expect(await readReceiptIssuer(db, s.ctx)).toMatchObject({ businessNumber: BIZ, certStatus: "NOT_REGISTERED" });
    expect(await db.auditLog.count({ where: { action: "seller.receipt_issuer.update", targetId: s.seller.id, actorId: s.owner.id } })).toBe(1);
  });

  it("틀린 사업자번호·빈 값은 거부하고, 권한 없는 직원은 보기·저장이 막힌다", async () => {
    const s = await setup();
    for (const body of [{ ...issuerBody, businessNumber: "220-81-62518" }, { ...issuerBody, companyName: "" }, { ...issuerBody, representative: "  " }, {}, null]) {
      expect(await saveReceiptIssuer(db, s.ctx, body), JSON.stringify(body)).toEqual({ ok: false, reason: "invalid_receipt_issuer" });
    }
    expect(await readReceiptIssuer(db, s.ctx)).toBeNull();
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const staffCtx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(saveReceiptIssuer(db, staffCtx, issuerBody)).rejects.toThrow();
    await expect(readReceiptIssuer(db, staffCtx)).rejects.toThrow();
  });

  it("사업자번호를 바꾸면 인증서 상태가 미등록으로 돌아가고, 같은 번호로 이름만 고치면 유지된다", async () => {
    const s = await setup();
    await registerIssuer(s);
    await saveReceiptIssuer(db, s.ctx, { ...issuerBody, companyName: "이름 바꾼 주식회사" });
    expect(await readReceiptIssuer(db, s.ctx)).toMatchObject({ companyName: "이름 바꾼 주식회사", certStatus: "REGISTERED" });
    const changed = await saveReceiptIssuer(db, s.ctx, { ...issuerBody, businessNumber: "1234567891" });
    expect(changed).toMatchObject({ ok: true, issuer: { certStatus: "NOT_REGISTERED", certCheckedAt: null } });
  });

  it("경로: 보기 null → 저장 200 → 보기, 잘못된 값 400", async () => {
    const s = await setup();
    const sl = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!sl.ok) throw new Error("login");
    const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie: `lo_seller=${sl.token}` };
    const url = "http://localhost:3000/api/seller/receipt-issuer";
    expect(await (await issuerGet(new Request(url, { headers: H }))).json()).toEqual({ issuer: null });
    const bad = await issuerPut(new Request(url, { method: "PUT", headers: H, body: JSON.stringify({ ...issuerBody, businessNumber: "1" }) }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_receipt_issuer" });
    const ok = await issuerPut(new Request(url, { method: "PUT", headers: H, body: JSON.stringify(issuerBody) }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await (await issuerGet(new Request(url, { headers: H }))).json()).toMatchObject({ issuer: { businessNumber: BIZ, certStatus: "NOT_REGISTERED" } });
  });
});

describe("발행 업체 연동 인터페이스", () => {
  const fake = (result: Awaited<ReturnType<ReceiptProvider["issue"]>>, calls: unknown[] = []): ReceiptProvider => ({
    name: "fake",
    issue: async (input) => {
      calls.push(input);
      return result;
    },
  });

  it("업체가 없으면(키 없음) 아무것도 바꾸지 않고 대기를 유지한다", async () => {
    const s = await setup();
    const id = await newIssue(s);
    await registerIssuer(s);
    expect(await processReceiptIssue(db, id)).toEqual({ ok: false, reason: "provider_not_configured" });
    expect(await issueRow(id)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await processReceiptIssue(db, "nope")).toEqual({ ok: false, reason: "not_found" });
  });

  it("발행자 정보가 없거나 인증서가 등록되지 않았으면 업체를 부르지 않고 대기를 유지한다", async () => {
    const s = await setup();
    const id = await newIssue(s);
    const calls: unknown[] = [];
    expect(await processReceiptIssue(db, id, fake({ ok: true, providerKey: "k" }, calls))).toEqual({ ok: false, reason: "issuer_not_ready" });
    await saveReceiptIssuer(db, s.ctx, issuerBody);
    expect(await processReceiptIssue(db, id, fake({ ok: true, providerKey: "k" }, calls))).toEqual({ ok: false, reason: "issuer_not_ready" });
    expect(calls).toEqual([]);
    expect(await issueRow(id)).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("성공하면 발행(업체 번호·시각)으로 닫고, 업체에는 풀어 쓴 번호와 파트너스 발행자 정보·발행 id(멱등 키)를 보낸다", async () => {
    const s = await setup();
    const id = await newIssue(s);
    await registerIssuer(s);
    const calls: Record<string, unknown>[] = [];
    expect(await processReceiptIssue(db, id, fake({ ok: true, providerKey: "doc-1" }, calls))).toEqual({ ok: true, issued: true });
    expect(await issueRow(id)).toMatchObject({ status: "ISSUED", attempts: 1, providerKey: "doc-1", failureCode: null });
    expect((await issueRow(id)).issuedAt).not.toBeNull();
    expect(calls).toEqual([
      { issueId: id, kind: "CASH_RECEIPT_INCOME", amount: 10000, identity: "01023456789", taxInfo: null, issuer: { businessNumber: "2208162517", companyName: "시험 주식회사", representative: "홍길동" } },
    ]);
    expect(await processReceiptIssue(db, id, fake({ ok: true, providerKey: "x" }, calls))).toEqual({ ok: false, reason: "not_pending" });
    expect(calls).toHaveLength(1);
  });

  it("업체가 실패를 돌려주면 실패(코드 기록)로 닫히고 파트너스가 다시 시도할 수 있다", async () => {
    const s = await setup();
    const id = await newIssue(s);
    await registerIssuer(s);
    expect(await processReceiptIssue(db, id, fake({ ok: false, code: "E-1001" }))).toEqual({ ok: true, issued: false });
    expect(await issueRow(id)).toMatchObject({ status: "FAILED", failureCode: "E-1001", attempts: 1 });
  });

  it("같은 발행을 동시에 처리해도 업체는 한 번만 부른다", async () => {
    const s = await setup();
    const id = await newIssue(s);
    await registerIssuer(s);
    const calls: unknown[] = [];
    const p = fake({ ok: true, providerKey: "doc-2" }, calls);
    const results = await Promise.all([processReceiptIssue(db, id, p), processReceiptIssue(db, id, p), processReceiptIssue(db, id, p)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(await issueRow(id)).toMatchObject({ status: "ISSUED", attempts: 1 });
  });

  it("업체를 부르는 사이 구매자가 철회하면 결과가 철회를 덮어쓰지 않는다", async () => {
    const s = await setup();
    const id = await newIssue(s);
    await registerIssuer(s);
    const { withdrawReceiptRequest } = await import("../../lib/server/receipts/service");
    const requestId = (await db.receiptIssue.findUniqueOrThrow({ where: { id } })).requestId;
    const racing: ReceiptProvider = {
      name: "racing",
      issue: async () => {
        await withdrawReceiptRequest(db, s.scope, requestId);
        return { ok: true, providerKey: "late" };
      },
    };
    await processReceiptIssue(db, id, racing);
    expect(await issueRow(id)).toMatchObject({ status: "CANCELLED", providerKey: null });
  });
});
