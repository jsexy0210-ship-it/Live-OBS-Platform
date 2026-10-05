import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as exportRoute } from "../../app/api/admin/billing/invoices/export/route";
import { POST as retryRoute } from "../../app/api/admin/billing/invoices/retry/route";
import { GET as listRoute } from "../../app/api/admin/billing/invoices/route";
import { BILLING_INVOICE_EXPORT_MAX, RETRY_MIN_GAP_MS, retryFailedInvoices } from "../../lib/server/admin/billingInvoices";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { openBillingKey } from "../../lib/server/billing/secret";
import { registerCardAndPay, renewDueSubscriptions } from "../../lib/server/billing/subscription";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 청구·결제 내역(MA-024): 월 요약·표시 상태·예정·매출전표·내보내기·실패 건 재시도(가짜 결제 공급자만, 실제 결제 없음)
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
});
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const DAY = 86_400_000;
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  const s = await createAdminSession(db, a.id, {});
  return { id: a.id, cookie: `lo_admin=${s.token}`, ctx: (await resolveAdminSession(db, s.token))! };
}
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
// 오늘(KST)부터 앞뒤로 넓게 잡은 기간
const kst = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const RANGE = `from=${kst(ago(5 * DAY))}&to=${kst(ahead(20 * DAY))}`;
const list = (cookie: string, qs = "") => listRoute(new Request(`http://localhost:3000/api/admin/billing/invoices?${RANGE}${qs}`, { headers: { ...H, cookie } }));
type Item = {
  id: string;
  paymentId: string | null;
  state: string;
  amount: number;
  amountEstimated: boolean;
  seller: { id: string; shopName: string };
  receipt: string;
  receiptUrl: string | null;
  paymentMethod: string | null;
  canRetry: boolean;
  refund: { amount: number } | null;
  planCode: string | null;
};
type Body = { items: Item[]; total: number; nextCursor: string | null; summary: Record<string, Record<string, number>>; range: { from: string; to: string } };
const body = async (r: Response) => (await r.json()) as Body;

let n = 0;
let plans: Awaited<ReturnType<typeof seedPlans>>;
// 승인된 파트너스 + 구독(카드 없음) 한 건. 청구는 pay로 넣는다.
async function shopSub(opts: { name?: string; plan?: "INTEGRATED" | "OVERLAY_ONLY"; sub?: Record<string, unknown>; seller?: Record<string, unknown> } = {}) {
  plans = await seedPlans();
  const { seller } = await createSeller();
  n++;
  const plan = plans[opts.plan ?? "INTEGRATED"];
  await db.seller.update({ where: { id: seller.id }, data: { approvedAt: ago(40 * DAY), planId: plan.id, shopName: opts.name ?? `청구몰${n}`, ...opts.seller } });
  const sub = await db.sellerSubscription.create({
    data: { sellerId: seller.id, planId: plan.id, subscribedAt: ago(40 * DAY), status: "ACTIVE", cardLabel: "테스트카드 1234", currentPeriodStart: ago(10 * DAY), currentPeriodEnd: ahead(20 * DAY), nextChargeAt: ahead(19 * DAY), ...opts.sub },
  });
  return { seller, sub, plan };
}
let pn = 0;
async function pay(s: { seller: { id: string }; sub: { id: string } }, data: Record<string, unknown> = {}) {
  pn++;
  return db.subscriptionPayment.create({
    data: { sellerId: s.seller.id, subscriptionId: s.sub.id, amount: 179000, status: "PAID", periodStart: ago(10 * DAY), periodEnd: ahead(20 * DAY), scheduled: true, createdAt: ago(pn * 1000), ...data } as never,
  });
}

describe("목록·월 요약 GET /api/admin/billing/invoices", () => {
  beforeEach(async () => {
    plans = await seedPlans();
  });

  it("표시 상태(결제 완료·진행 중·재시도·연체·실패·환불·예정)와 월 요약 숫자·매출전표·결제 수단, 다른 기간·승인 전·조건 안 맞는 예정은 빠진다", async () => {
    const { cookie } = await admin("READ_ONLY");
    const paid = await shopSub({ name: "완료몰" });
    const paidP = await pay(paid, { receiptUrl: "https://pg.example/receipt/1", paidAt: new Date() });
    const noSlip = await shopSub({ name: "전표없음몰" });
    await pay(noSlip, { paidAt: new Date() });
    const pending = await shopSub({ name: "진행중몰" });
    await pay(pending, { status: "PENDING" });
    const retrying = await shopSub({ name: "재시도몰", sub: { status: "PAST_DUE", nextChargeAt: ahead(DAY), graceUntil: ahead(6 * DAY), retryCount: 1, billingKeyCipher: "x" } });
    const retryingP = await pay(retrying, { status: "FAILED", failureReason: "card_declined" });
    const overdue = await shopSub({ name: "연체몰", sub: { status: "PAST_DUE", nextChargeAt: null, graceUntil: ago(DAY), retryCount: 3, billingKeyCipher: "x" } });
    await pay(overdue, { status: "FAILED", failureReason: "card_declined" });
    // 실패 뒤에 결제가 이어진 구독: 과거 실패(FAILED)
    const old = await shopSub({ name: "옛실패몰" });
    await pay(old, { status: "FAILED", createdAt: ago(3 * DAY) });
    await pay(old, { status: "PAID", createdAt: ago(DAY), receiptUrl: "https://pg.example/receipt/2" });
    const refunded = await shopSub({ name: "환불몰" });
    const refundedP = await pay(refunded, { receiptUrl: "https://pg.example/receipt/3", paidAt: new Date() });
    await db.subscriptionRefund.create({ data: { sellerId: refunded.seller.id, paymentId: refundedP.id, amount: 179000, source: "ADMIN", reason: "중복 결제", status: "REFUNDED", refundedAt: new Date() } });
    // 예정: 기간 안·아직 안 지남·자동결제 가능
    const sched = await shopSub({ name: "예정몰", plan: "OVERLAY_ONLY", sub: { nextChargeAt: ahead(3 * DAY), billingKeyCipher: "x" } });
    // 예정에서 빠지는 것들: 해지 예약·카드 없음·정지·진행 중 청구·이미 지남·기간 밖
    await shopSub({ name: "해지예약", sub: { nextChargeAt: ahead(3 * DAY), billingKeyCipher: "x", cancelAtPeriodEnd: true } });
    await shopSub({ name: "카드없음", sub: { nextChargeAt: ahead(3 * DAY) } });
    await shopSub({ name: "정지몰", sub: { nextChargeAt: ahead(3 * DAY), billingKeyCipher: "x" }, seller: { status: "SUSPENDED" } });
    const busy = await shopSub({ name: "진행중청구", sub: { nextChargeAt: ahead(3 * DAY), billingKeyCipher: "x" } });
    await pay(busy, { status: "PENDING", createdAt: ago(60 * DAY) }); // 기간 밖 청구지만 진행 중이라 예정에서 빠진다
    await shopSub({ name: "이미지남", sub: { nextChargeAt: ago(DAY), billingKeyCipher: "x" } });
    await shopSub({ name: "기간밖", sub: { nextChargeAt: ahead(60 * DAY), billingKeyCipher: "x" } });
    // 기간 밖 청구는 요약에서 빠진다
    const outside = await shopSub({ name: "기간밖청구" });
    await pay(outside, { createdAt: ago(60 * DAY) });

    const b = await body(await list(cookie, "&limit=100"));
    const byShop = Object.fromEntries(b.items.map((i) => [i.seller.shopName, i]));
    expect(Object.keys(byShop).sort()).toEqual(["완료몰", "전표없음몰", "진행중몰", "재시도몰", "연체몰", "옛실패몰", "환불몰", "예정몰"].sort());
    expect(b.items.filter((i) => i.seller.shopName === "옛실패몰").map((i) => i.state).sort()).toEqual(["FAILED", "PAID"]);
    expect(byShop["완료몰"]).toMatchObject({ state: "PAID", receipt: "ISSUED", receiptUrl: "https://pg.example/receipt/1", paymentMethod: "테스트카드 1234", paymentId: paidP.id, planCode: "INTEGRATED", canRetry: false });
    expect(byShop["전표없음몰"]).toMatchObject({ state: "PAID", receipt: "NOT_ISSUED", receiptUrl: null });
    expect(byShop["진행중몰"]).toMatchObject({ state: "PENDING", receipt: "NOT_ISSUED" });
    expect(byShop["재시도몰"]).toMatchObject({ state: "RETRYING", receipt: "NOT_ISSUED", canRetry: true, paymentId: retryingP.id });
    expect(byShop["연체몰"]).toMatchObject({ state: "OVERDUE", canRetry: true });
    expect(byShop["환불몰"]).toMatchObject({ state: "REFUNDED", receipt: "CANCELED", receiptUrl: null, refund: { amount: 179000 }, paymentId: refundedP.id });
    // 예정: 청구 번호 없이 구독 id, 금액은 예상(오버레이 전용 판매가)
    expect(byShop["예정몰"]).toMatchObject({ state: "SCHEDULED", paymentId: null, id: sched.sub.id, receipt: "SCHEDULED", amountEstimated: true, amount: plans.OVERLAY_ONLY.salePrice, planCode: "OVERLAY_ONLY" });
    // 카드(빌링키)가 없는 구독의 실패 건은 재시도할 수 없다
    const noCard = await shopSub({ name: "카드삭제몰", sub: { status: "PAST_DUE", nextChargeAt: ahead(DAY), graceUntil: ahead(6 * DAY) } });
    await pay(noCard, { status: "FAILED" });
    expect((await body(await list(cookie, `&q=${encodeURIComponent("카드삭제")}`))).items[0]).toMatchObject({ state: "RETRYING", canRetry: false });
    const stale = b.items.find((i) => i.seller.shopName === "옛실패몰" && i.state === "FAILED")!;
    expect(stale.canRetry).toBe(false); // 최신 청구가 아니다
    // 요약(기간 전체): 청구 8건(예정 제외): 완료·전표없음·진행 중·재시도·연체·옛실패 2·환불
    expect(b.summary.total).toEqual({ count: 8, amount: 8 * 179000 });
    expect(b.summary.paid).toEqual({ count: 4, amount: 4 * 179000 }); // 완료몰·전표없음몰·옛실패몰 PAID·환불몰(환불 포함)
    expect(b.summary.failed).toEqual({ count: 3, amount: 3 * 179000, retrying: 1, overdue: 1 });
    expect(b.summary.pending).toEqual({ count: 1 });
    expect(b.summary.refunded).toEqual({ count: 1, amount: 179000 });
    expect(b.summary.scheduled).toEqual({ count: 1, estimatedAmount: plans.OVERLAY_ONLY.salePrice });
    expect(b.total).toBe(9);
    // 청구 시각(예정은 다음 결제 시각) 내림차순: 예정이 맨 위
    expect(b.items[0].seller.shopName).toBe("예정몰");
    // 키·원문은 없다
    const raw = JSON.stringify(b);
    for (const key of ["billingKeyCipher", "providerPaymentId", "passwordHash"]) expect(raw).not.toContain(key);
  });

  it("필터: state·failedOnly·plan·검색(와일드카드는 글자로)·sellerId. 요약은 필터와 관계없이 기간 전체", async () => {
    const { cookie } = await admin("CS");
    const a = await shopSub({ name: "100%몰" });
    await pay(a);
    const b = await shopSub({ name: "오버레이몰", plan: "OVERLAY_ONLY", sub: { status: "PAST_DUE", nextChargeAt: ahead(DAY), graceUntil: ahead(5 * DAY) } });
    await pay(b, { status: "FAILED", amount: 69000 });
    const names = async (qs: string) => (await body(await list(cookie, qs))).items.map((i) => i.seller.shopName).sort();
    expect(await names("&state=PAID")).toEqual(["100%몰"]);
    expect(await names("&state=RETRYING")).toEqual(["오버레이몰"]);
    expect(await names("&failedOnly=1")).toEqual(["오버레이몰"]);
    expect(await names("&plan=OVERLAY_ONLY")).toEqual(["오버레이몰"]);
    expect(await names("&plan=INTEGRATED")).toEqual(["100%몰"]);
    expect(await names(`&q=${encodeURIComponent("%")}`)).toEqual(["100%몰"]);
    expect(await names(`&q=${encodeURIComponent("오버")}`)).toEqual(["오버레이몰"]);
    expect(await names(`&sellerId=${b.seller.id}`)).toEqual(["오버레이몰"]);
    const filtered = await body(await list(cookie, "&state=PAID"));
    expect(filtered.summary.total.count).toBe(2);
    expect(filtered.total).toBe(1);
    for (const qs of ["&state=NOPE", "&plan=X", "&failedOnly=2", "&sellerId=bad", "&limit=0", "&limit=101", "&cursor=-1", "&cursor=x", `&q=${"가".repeat(51)}`]) {
      expect((await list(cookie, qs)).status, qs).toBe(400);
    }
  });

  it("쪽 이동(건너뛸 개수)은 빠짐·겹침 없이 끝까지, 월 지정(month)은 그 달(KST)만, 기간은 최대 366일", async () => {
    const { cookie } = await admin("OPERATIONS");
    for (let i = 0; i < 5; i++) await pay(await shopSub({ name: `쪽${i}` }), { createdAt: ago(i * 3_600_000) });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r: Body = await body(await list(cookie, `&limit=2${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...r.items.map((x) => x.seller.shopName));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["쪽0", "쪽1", "쪽2", "쪽3", "쪽4"]);
    // 지난 달 청구
    const lastMonth = await shopSub({ name: "지난달몰" });
    const at = new Date("2026-03-15T03:00:00Z");
    await pay(lastMonth, { createdAt: at });
    const m = await listRoute(new Request("http://localhost:3000/api/admin/billing/invoices?month=2026-03", { headers: { ...H, cookie } }));
    const mb = await body(m);
    expect(mb.range).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(mb.items.map((i) => i.seller.shopName)).toEqual(["지난달몰"]);
    for (const qs of ["month=2026-13", "month=abc", "month=2026-03&from=2026-03-01", `from=2026-01-01&to=2027-06-01`, "from=2026-03-05&to=2026-03-01"]) {
      const r = await listRoute(new Request(`http://localhost:3000/api/admin/billing/invoices?${qs}`, { headers: { ...H, cookie } }));
      expect(r.status, qs).toBe(400);
    }
  });

  it("관리자 세션이 없으면 401", async () => {
    expect((await list("")).status).toBe(401);
  });
});

describe("내보내기 GET /api/admin/billing/invoices/export", () => {
  it("같은 조건의 CSV(BOM, 한글 열, 수식 문자 방지)와 로그 추적. 조회 전용도 내려받을 수 있고 잘못된 조건은 400", async () => {
    const { cookie, id } = await admin("READ_ONLY");
    const a = await shopSub({ name: "=SUM(A1)몰" });
    await pay(a, { receiptUrl: "https://pg.example/r", paidAt: new Date() });
    const b = await shopSub({ name: "실패몰", sub: { status: "PAST_DUE", nextChargeAt: ahead(DAY), graceUntil: ahead(5 * DAY) } });
    await pay(b, { status: "FAILED", failureReason: "card_declined" });
    const get = (qs: string) => exportRoute(new Request(`http://localhost:3000/api/admin/billing/invoices/export?${RANGE}${qs}`, { headers: { ...H, cookie } }));
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("billing-");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith("\uFEFF청구일,쇼핑몰,주소,요금제,구분,금액,상태,결제 수단,매출전표,결제일,환불액,실패 사유")).toBe(true);
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(text).toContain("'=SUM(A1)몰");
    expect(text).toContain("결제 완료");
    expect(text).toContain("실패·재시도");
    expect(text).toContain("card_declined");
    expect(text).not.toContain("billingKeyCipher");
    const failedOnly = (await (await get("&failedOnly=1")).text()).trim().split("\r\n");
    expect(failedOnly).toHaveLength(2);
    expect(await db.auditLog.count({ where: { action: "admin.billing.export", actorId: id } })).toBe(2);
    expect((await get("&state=NOPE")).status).toBe(400);
    expect(BILLING_INVOICE_EXPORT_MAX).toBe(5000);
  });
});

describe("실패 건 재시도 POST /api/admin/billing/invoices/retry", () => {
  // 처음 결제는 성공, 다음 달 자동결제가 거절돼 실패한 구독. 실패 청구는 2시간 전에 만든 것으로 돌려 5분 간격을 지난 상태로 둔다.
  async function failedShop(provider: FakeBillingProvider, name = "재시도몰") {
    const { seller } = await createSeller();
    const p = await seedPlans();
    await db.seller.update({ where: { id: seller.id }, data: { approvedAt: ago(40 * DAY), trialEndsAt: ago(DAY), planId: p.STANDARD.id, shopName: name } });
    const owner = await createSellerUser(seller.id, "OWNER");
    const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
    await registerCardAndPay(db, provider, ctx, { authKey: `k-${seller.id}` });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: seller.id } });
    provider.decline(openBillingKey(sub.billingKeyCipher!, seller.id));
    await renewDueSubscriptions(db, provider, { now: new Date(sub.currentPeriodEnd!.getTime() - DAY / 2) });
    // 처음(결제 완료) 청구는 한 달 전 것으로 돌려 실패 청구가 최신이 되게 한다
    await db.subscriptionPayment.updateMany({ where: { sellerId: seller.id, status: "PAID" }, data: { createdAt: ago(30 * DAY) } });
    const failed = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: seller.id, status: "FAILED" } });
    await db.subscriptionPayment.update({ where: { id: failed.id }, data: { createdAt: ago(2 * 3_600_000) } });
    return { seller, sub, failed, key: openBillingKey(sub.billingKeyCipher!, seller.id) };
  }
  const retry = (cookie: string, ids: unknown) =>
    retryRoute(new Request("http://localhost:3000/api/admin/billing/invoices/retry", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ paymentIds: ids }) }));

  it("카드를 다시 결제하면 새 청구가 결제 완료되고 구독이 정상으로 돌아온다. 같은 건을 또 재시도하면 최신 청구가 아니라서 거절", async () => {
    const provider = new FakeBillingProvider();
    const { ctx } = await admin("OPERATIONS");
    const s = await failedShop(provider);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: s.sub.id } })).status).toBe("PAST_DUE");
    // 카드 문제가 풀린 것으로: 거절 목록을 비운 새 공급자
    const fresh = new FakeBillingProvider();
    const r = await retryFailedInvoices(db, fresh, ctx, [s.failed.id]);
    expect(r).toMatchObject({ ok: true, succeeded: 1, failed: 0, results: [{ paymentId: s.failed.id, ok: true, result: "PAID" }] });
    expect(fresh.charges).toHaveLength(1);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: s.sub.id } })).toMatchObject({ status: "ACTIVE", retryCount: 0, graceUntil: null });
    expect(await db.subscriptionPayment.count({ where: { sellerId: s.seller.id, status: "PAID" } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: "admin.billing.retry", targetId: s.failed.id } })).toBe(1);
    expect(await retryFailedInvoices(db, fresh, ctx, [s.failed.id])).toMatchObject({ results: [{ ok: false, reason: "not_latest" }] });
  });

  it("다시 거절되면 실패 결과를 돌려주고 재시도 횟수만 오른다. 5분 안에 또 하면 too_soon", async () => {
    const provider = new FakeBillingProvider();
    const { ctx } = await admin("SUPER_ADMIN");
    const s = await failedShop(provider);
    provider.decline(s.key);
    const r = await retryFailedInvoices(db, provider, ctx, [s.failed.id]);
    expect(r.ok && r.results[0]).toMatchObject({ ok: false, result: "FAILED", reason: "charge_failed" });
    const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(sub).toMatchObject({ status: "PAST_DUE", retryCount: 1 });
    const second = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: s.seller.id, status: "FAILED", id: { not: s.failed.id } } });
    // 방금 만든 청구 기준으로 5분이 안 지났다
    expect(await retryFailedInvoices(db, provider, ctx, [second.id])).toMatchObject({ results: [{ ok: false, reason: "too_soon" }] });
    // 간격이 지나면 다시 시도할 수 있다
    await db.subscriptionPayment.update({ where: { id: second.id }, data: { createdAt: new Date(Date.now() - RETRY_MIN_GAP_MS - 1000) } });
    expect(await retryFailedInvoices(db, provider, ctx, [second.id])).toMatchObject({ results: [{ ok: false, reason: "charge_failed" }] });
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: s.sub.id } })).retryCount).toBe(2);
  });

  it("건별 결과: 한 건이 안 돼도 나머지는 처리한다(옛 실패·결제 완료 건·해지 예약·없는 건). 1~50건만", async () => {
    const provider = new FakeBillingProvider();
    const { ctx } = await admin("OPERATIONS");
    const ok = await failedShop(provider, "성공몰");
    const canceled = await failedShop(provider, "해지몰");
    await db.sellerSubscription.update({ where: { id: canceled.sub.id }, data: { cancelAtPeriodEnd: true } });
    const paidP = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: ok.seller.id, status: "PAID" } });
    const ghost = "00000000-0000-4000-8000-000000000000";
    const fresh = new FakeBillingProvider();
    const r = await retryFailedInvoices(db, fresh, ctx, [ok.failed.id, canceled.failed.id, paidP.id, ghost, "bad", ok.failed.id]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.results).toEqual([
      { paymentId: ok.failed.id, ok: true, result: "PAID" },
      { paymentId: canceled.failed.id, ok: false, reason: "not_retryable" },
      { paymentId: paidP.id, ok: false, reason: "not_failed" },
      { paymentId: ghost, ok: false, reason: "not_found" },
      { paymentId: "bad", ok: false, reason: "not_found" },
    ]);
    expect([r.succeeded, r.failed]).toEqual([1, 4]);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: canceled.sub.id } })).status).toBe("PAST_DUE");
    for (const bad of [[], "x", Array.from({ length: 51 }, () => ghost)]) {
      expect(await retryFailedInvoices(db, fresh, ctx, bad)).toEqual({ ok: false, reason: "invalid_ids" });
    }
  });

  it("정지된 쇼핑몰은 재시도하지 않는다. 조회 전용·CS는 403(결제 시도 없음), 최고관리자·운영만 route로 재시도", async () => {
    const provider = new FakeBillingProvider();
    const sus = await failedShop(provider, "정지몰");
    await db.seller.update({ where: { id: sus.seller.id }, data: { status: "SUSPENDED" } });
    const { ctx } = await admin("OPERATIONS");
    expect(await retryFailedInvoices(db, new FakeBillingProvider(), ctx, [sus.failed.id])).toMatchObject({ results: [{ ok: false, reason: "not_retryable" }] });
    await db.seller.update({ where: { id: sus.seller.id }, data: { status: "ACTIVE" } });
    for (const role of ["READ_ONLY", "CS"] as Role[]) {
      const a = await admin(role);
      expect((await retry(a.cookie, [sus.failed.id])).status).toBe(403);
    }
    expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { id: sus.failed.id } })).status).toBe("FAILED");
    expect(await db.subscriptionPayment.count({ where: { sellerId: sus.seller.id } })).toBe(2);
    // route: 최고관리자는 가짜 공급자로 재시도된다(실제 결제 없음). 잘못된 본문은 400
    const boss = await admin("SUPER_ADMIN");
    expect((await retry(boss.cookie, [])).status).toBe(400);
    const res = await retry(boss.cookie, [sus.failed.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ succeeded: 1, results: [{ result: "PAID" }] });
  });
});
