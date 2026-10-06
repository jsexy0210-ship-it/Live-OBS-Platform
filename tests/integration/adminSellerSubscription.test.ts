import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/admin/sellers/[sellerId]/subscription/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { createAdmin, createSeller, db, resetDb, seedPlans } from "./helpers";

// 마스터 파트너스 상세 「구독」 탭(MA-012-3): 상태 이력과 파트너스별 청구·결제 내역 표(조회만, 모든 마스터 역할)
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function cookie(role: Role = "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = async (sellerId: string, qs = "", c?: string) => route(new Request(`http://localhost:3000/api/admin/sellers/${sellerId}/subscription${qs}`, { headers: { ...H, ...(c ? { cookie: c } : {}) } }), { params: Promise.resolve({ sellerId }) });
type Body = {
  history: { at: string; kind: string; text: string }[];
  trial: { startedAt: string; endsAt: string; days: number } | null;
  invoices: { items: { id: string; kind: string; state: string; amount: number; seller?: { id: string }; refund?: { amount: number } | null; planName: string | null }[]; total: number; nextCursor: string | null };
  totals: { paidAmount: number; paidCount: number; refundedAmount: number; refundedCount: number };
};

let n = 0;
// 승인 60일 전(체험 7일) → 8일째 첫 결제 → 이후 결제. 구독은 카드가 있고 다음 결제가 예정돼 있다.
async function shop(opts: { trial?: boolean } = {}) {
  const plans = await seedPlans();
  const { seller } = await createSeller();
  n++;
  const approvedAt = ago(60 * DAY);
  await db.seller.update({ where: { id: seller.id }, data: { approvedAt, trialEndsAt: opts.trial === false ? null : new Date(approvedAt.getTime() + 7 * DAY), planId: plans.INTEGRATED.id, shopName: `구독몰${n}` } });
  const sub = await db.sellerSubscription.create({
    data: { sellerId: seller.id, planId: plans.INTEGRATED.id, subscribedAt: approvedAt, status: "ACTIVE", cardLabel: "테스트카드 1234", billingKeyCipher: "x", currentPeriodStart: ago(5 * DAY), currentPeriodEnd: ahead(25 * DAY), nextChargeAt: ahead(25 * DAY) },
  });
  return { seller, sub, plans };
}
let pn = 0;
const pay = (s: { seller: { id: string }; sub: { id: string } }, data: Record<string, unknown> = {}) => {
  pn++;
  return db.subscriptionPayment.create({
    data: { sellerId: s.seller.id, subscriptionId: s.sub.id, amount: 179000, status: "PAID", periodStart: new Date(Date.UTC(2026, 0, 1) + pn * DAY), periodEnd: new Date(Date.UTC(2026, 0, 31) + pn * DAY), scheduled: true, paidAt: new Date(), createdAt: ago(pn * 1000), ...data } as never,
  });
};

describe("파트너스 구독 탭 GET /api/admin/sellers/{sellerId}/subscription", () => {
  it("권한·입력: 로그인 없으면 401, 모든 마스터 역할(조회 전용 포함)은 200, 없는 파트너스 404, 잘못된 cursor·limit 400", async () => {
    const s = await shop();
    expect((await get(s.seller.id)).status).toBe(401);
    for (const role of ["READ_ONLY", "CS", "OPERATIONS", "SUPER_ADMIN"] as Role[]) expect((await get(s.seller.id, "", await cookie(role))).status, role).toBe(200);
    const c = await cookie();
    expect((await get("00000000-0000-4000-8000-000000000000", "", c)).status).toBe(404);
    expect((await get("not-a-uuid", "", c)).status).toBe(404);
    for (const bad of ["?limit=0", "?limit=101", "?limit=x", "?cursor=x", "?cursor=-1"]) expect((await get(s.seller.id, bad, c)).status, bad).toBe(400);
  });

  it("상태 이력(최신순): 체험 시작 → 첫 결제 성공 → 카드·해지 예약·복구·정지 등. 구독을 해지해 닫힌 청구는 결제 실패로 세지 않는다", async () => {
    const s = await shop();
    const first = await pay(s, { createdAt: ago(52 * DAY), paidAt: ago(52 * DAY), scheduled: false });
    await pay(s, { createdAt: ago(22 * DAY), paidAt: ago(22 * DAY) });
    await pay(s, { status: "FAILED", createdAt: ago(8 * DAY), failureReason: "card_declined", paidAt: null });
    await pay(s, { status: "FAILED", createdAt: ago(3 * DAY), failureReason: "canceled", paidAt: null });
    const refundedP = await pay(s, { createdAt: ago(2 * DAY), paidAt: ago(2 * DAY) });
    await db.subscriptionRefund.create({ data: { sellerId: s.seller.id, paymentId: refundedP.id, amount: 179000, source: "ADMIN", reason: "중복 결제", status: "REFUNDED", refundedAt: ago(DAY) } });
    const audit = (action: string, at: Date, after?: object) => db.auditLog.create({ data: { actorType: "SYSTEM", sellerId: s.seller.id, action, createdAt: at, ...(after ? { after } : {}) } });
    await audit("subscription.card_registered", ago(53 * DAY));
    await audit("subscription.card_rejected", ago(54 * DAY));
    await audit("subscription.cancel", ago(6 * DAY), { endsAt: new Date("2026-11-10T00:00:00Z").toISOString(), immediate: false });
    await audit("subscription.restored", ago(5 * DAY));
    await audit("admin.seller.suspend", ago(4 * DAY));
    await audit("admin.seller.unsuspend", ago(3 * DAY + 1000));
    await audit("subscription.canceled", ago(2 * DAY + 2000));
    await audit("subscription.cancel", ago(30 * DAY), { endsAt: null, immediate: true });
    await db.auditLog.create({ data: { actorType: "SYSTEM", sellerId: s.seller.id, action: "order.deliver", createdAt: ago(DAY) } }); // 관계없는 기록
    const b = (await (await get(s.seller.id, "", await cookie())).json()) as Body;
    expect(b.history.map((h) => h.kind)).toEqual([
      "REFUNDED", // 1일 전
      "CANCELED", // 2일 + 2초 전(기간 종료)
      "UNSUSPENDED",
      "SUSPENDED",
      "RESTORED",
      "CANCEL_SCHEDULED",
      "PAYMENT_FAILED", // 8일 전(해지로 닫힌 청구는 빠짐)
      "CANCELED", // 30일 전 즉시 해지
      "FIRST_PAID", // 52일 전
      "CARD_REGISTERED", // 53일 전
      "CARD_REJECTED", // 54일 전
      "TRIAL_STARTED", // 60일 전
    ]);
    const text = (k: string) => b.history.find((h) => h.kind === k)?.text ?? "";
    expect(text("TRIAL_STARTED")).toMatch(/^체험 시작 \(7일 · .+\)$/);
    expect(text("FIRST_PAID")).toMatch(/^체험 → 이용 중 \(첫 결제 성공 · .+으로 시작\)$/);
    expect(text("CANCEL_SCHEDULED")).toBe("해지 예약 (2026.11.10 종료)");
    expect(text("PAYMENT_FAILED")).toBe("자동결제 실패 (179,000원)");
    expect(text("REFUNDED")).toBe("환불 완료 (179,000원)");
    // 첫 결제 시각은 가장 이른 결제 완료
    expect(new Date(b.history.find((h) => h.kind === "FIRST_PAID")!.at).getTime()).toBe(first.paidAt!.getTime());
    expect(b.trial).toMatchObject({ days: 7 });
  });

  it("청구 표: 예정 → 결제 내역(최신순) → 체험 0원 항목(마지막 쪽 끝), 누적 결제·환불 합계, 쪽 나누기는 체험을 센 total에 넣지 않는다", async () => {
    const s = await shop();
    await pay(s, { createdAt: ago(35 * DAY), paidAt: ago(35 * DAY), receiptUrl: "https://pg.example/r/1" });
    await pay(s, { createdAt: ago(5 * DAY), paidAt: ago(5 * DAY), receiptUrl: "https://pg.example/r/2" });
    const refundedP = await pay(s, { createdAt: ago(2 * DAY), paidAt: ago(2 * DAY), amount: 100000 });
    await db.subscriptionRefund.create({ data: { sellerId: s.seller.id, paymentId: refundedP.id, amount: 60000, source: "ADMIN", reason: "일부 환불", status: "REFUNDED", refundedAt: ago(DAY) } });
    const c = await cookie();
    const all = (await (await get(s.seller.id, "?limit=100", c)).json()) as Body;
    expect(all.invoices.items.map((i) => i.state)).toEqual(["SCHEDULED", "REFUNDED", "PAID", "PAID", "TRIAL"]);
    expect(all.invoices.total).toBe(4);
    expect(all.invoices.nextCursor).toBeNull();
    expect(all.invoices.items[4]).toMatchObject({ kind: "TRIAL", amount: 0 });
    expect(all.totals).toEqual({ paidAmount: 179000 * 2 + 100000, paidCount: 3, refundedAmount: 60000, refundedCount: 1 });
    expect(all.invoices.items[1].refund).toMatchObject({ amount: 60000 });
    // 쪽 나누기: 2건씩 → 체험은 마지막 쪽에만
    const p1 = (await (await get(s.seller.id, "?limit=2", c)).json()) as Body;
    expect(p1.invoices.items.map((i) => i.state)).toEqual(["SCHEDULED", "REFUNDED"]);
    expect(p1.invoices.nextCursor).toBe("2");
    const p2 = (await (await get(s.seller.id, `?limit=2&cursor=${p1.invoices.nextCursor}`, c)).json()) as Body;
    expect(p2.invoices.items.map((i) => i.state)).toEqual(["PAID", "PAID", "TRIAL"]);
    expect(p2.invoices.nextCursor).toBeNull();
    expect(p2.totals).toEqual(p1.totals);
  });

  it("다른 파트너스의 청구·이력은 섞이지 않고, 체험이 없는 파트너스는 trial이 null이며 체험 항목도 없다", async () => {
    const a = await shop();
    const b = await shop({ trial: false });
    await pay(a, { createdAt: ago(3 * DAY) });
    await pay(b, { createdAt: ago(3 * DAY), amount: 99000 });
    await db.auditLog.create({ data: { actorType: "SYSTEM", sellerId: b.seller.id, action: "subscription.card_registered", createdAt: ago(DAY) } });
    const c = await cookie();
    const ra = (await (await get(a.seller.id, "", c)).json()) as Body;
    const rb = (await (await get(b.seller.id, "", c)).json()) as Body;
    expect(ra.invoices.items.map((i) => i.seller?.id).filter(Boolean)).toEqual([a.seller.id, a.seller.id]); // 예정 + 결제
    expect(ra.history.map((h) => h.kind)).not.toContain("CARD_REGISTERED");
    expect(ra.totals.paidAmount).toBe(179000);
    expect(rb.trial).toBeNull();
    expect(rb.invoices.items.map((i) => i.state)).toEqual(["SCHEDULED", "PAID"]);
    expect(rb.history.map((h) => h.kind)).toContain("CARD_REGISTERED");
    expect(rb.history.map((h) => h.kind)).not.toContain("TRIAL_STARTED");
    expect(rb.totals.paidAmount).toBe(99000);
  });

  it("구독·결제 기록이 하나도 없는 파트너스도 빈 값으로 200", async () => {
    await seedPlans();
    const { seller } = await createSeller();
    const b = (await (await get(seller.id, "", await cookie())).json()) as Body;
    expect(b).toMatchObject({ history: [], trial: null, invoices: { items: [], total: 0, nextCursor: null }, totals: { paidAmount: 0, paidCount: 0, refundedAmount: 0, refundedCount: 0 } });
  });
});
