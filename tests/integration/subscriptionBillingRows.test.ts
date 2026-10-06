import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as exportGet } from "../../app/api/seller/subscription/payments/export/route";
import { GET as viewGet } from "../../app/api/seller/subscription/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// SA-090 구독·결제 정본 v328 정렬 서버: 구독 응답 확장(월 무료 메일·런칭 할인·구독 시작·청구 주기)과 합친 청구 내역(billingRows), CSV 내보내기.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const DAY = 86_400_000;
const H = { host: "localhost:3000" };
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
const view = async (cookie: string) => {
  const r = await viewGet(new Request("http://localhost:3000/api/seller/subscription", { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};

async function shop(opts: { cancel?: boolean; trialEndsAt?: Date | null } = {}) {
  const plans = await seedPlans();
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const approvedAt = ago(60 * DAY);
  await db.seller.update({ where: { id: seller.id }, data: { approvedAt, trialEndsAt: opts.trialEndsAt === undefined ? new Date(approvedAt.getTime() + 7 * DAY) : opts.trialEndsAt, planId: plans.INTEGRATED.id } });
  await db.subscriptionPlan.update({ where: { id: plans.INTEGRATED.id }, data: { mailMonthlyQuota: 2000 } });
  const sub = await db.sellerSubscription.create({
    data: {
      sellerId: seller.id,
      planId: plans.INTEGRATED.id,
      subscribedAt: new Date("2026-08-10T00:05:00+09:00"),
      billingAnchorAt: new Date("2026-08-10T00:05:00+09:00"),
      status: "ACTIVE",
      cardLabel: "테스트카드 1234",
      billingKeyCipher: "x",
      currentPeriodStart: ago(5 * DAY),
      currentPeriodEnd: ahead(25 * DAY),
      nextChargeAt: ahead(24 * DAY),
      cancelAtPeriodEnd: opts.cancel ?? false,
    },
  });
  return { seller, owner, sub, plans, cookie: await cookieOf(owner.email) };
}

let pn = 0;
const pay = (s: { seller: { id: string }; sub: { id: string } }, data: Record<string, unknown> = {}) => {
  pn++;
  return db.subscriptionPayment.create({
    data: { sellerId: s.seller.id, subscriptionId: s.sub.id, amount: 179000, status: "PAID", periodStart: new Date(Date.UTC(2026, 6, 10) + pn * 31 * DAY), periodEnd: new Date(Date.UTC(2026, 7, 9) + pn * 31 * DAY), scheduled: true, ...data } as never,
  });
};
const charge = (s: { seller: { id: string }; owner: { id: string } }, data: Record<string, unknown> = {}) =>
  db.messageCharge.create({ data: { sellerId: s.seller.id, sellerUserId: s.owner.id, amount: 10000, status: "PAID", idempotencyKey: `k${++pn}`, noticeVersion: "v1", ...data } as never });

describe("구독 응답 확장 GET /api/seller/subscription", () => {
  it("plan에 월 무료 메일·런칭 할인 여부, subscription에 구독 시작·청구 주기·체험 거침을 더한다(첫 성공 전 할인 종료일은 null). 기존 필드는 그대로", async () => {
    const s = await shop();
    const r = await view(s.cookie);
    expect(r.status).toBe(200);
    expect(r.body.plan).toMatchObject({ code: "INTEGRATED", listPrice: 249000, salePrice: 179000, nextAmount: 179000, mailMonthlyQuota: 2000, launchDiscount: { active: true, endsAt: null } });
    expect(r.body.subscription).toMatchObject({ status: "ACTIVE", cardLabel: "테스트카드 1234", billingDay: 10, startedFromTrial: true });
    expect(r.body.subscription.subscribedAt).toBe(new Date("2026-08-10T00:05:00+09:00").toISOString());
    expect(Array.isArray(r.body.payments)).toBe(true);
  });

  it("할인 기간이 끝난 구독은 launchDiscount.active=false, 체험이 없던 판매자는 startedFromTrial=false", async () => {
    const s = await shop({ trialEndsAt: null });
    await db.seller.update({ where: { id: s.seller.id }, data: { launchDiscountUsedAt: ago(200 * DAY) } });
    const r = await view(s.cookie);
    expect(r.body.plan).toMatchObject({ nextAmount: 249000, launchDiscount: { active: false } });
    expect(r.body.plan.launchDiscount.endsAt).toBeTruthy();
    expect(r.body.subscription.startedFromTrial).toBe(false);
  });
});

describe("청구 내역 billingRows", () => {
  it("맨 위에 다음 결제 예정 1건, 이어서 구독료·차액·발송·이용 충전을 시간순으로 합친다. payments는 예정·충전 행 없이 그대로", async () => {
    const s = await shop();
    await pay(s, { createdAt: ago(40 * DAY), paidAt: ago(40 * DAY), receiptUrl: "https://example.com/r1" });
    await charge(s, { createdAt: ago(20 * DAY), finishedAt: ago(20 * DAY), receiptUrl: "https://example.com/c1" });
    await pay(s, { kind: "PRORATION", amount: 25667, createdAt: ago(10 * DAY), paidAt: ago(10 * DAY), scheduled: false });
    await pay(s, { status: "FAILED", createdAt: ago(3 * DAY), paidAt: null, failureReason: "card_declined" });
    await charge(s, { status: "PENDING", amount: 5000, createdAt: ago(DAY), finishedAt: null });
    const r = await view(s.cookie);
    const rows = r.body.billingRows as { id: string; kind: string; state: string; amount: number; billingMonth: string; at: string; receiptUrl: string | null }[];
    expect(rows.map((x) => [x.kind, x.state, x.amount])).toEqual([
      ["SUBSCRIPTION", "SCHEDULED", 179000],
      ["MESSAGE_CHARGE", "PENDING", 5000],
      ["SUBSCRIPTION", "FAILED", 179000],
      ["PRORATION", "PAID", 25667],
      ["MESSAGE_CHARGE", "PAID", 10000],
      ["SUBSCRIPTION", "PAID", 179000],
    ]);
    expect(rows[0]).toMatchObject({ receiptUrl: null });
    expect(new Date(rows[0]!.at).getTime() - Date.now()).toBeGreaterThan(23 * DAY);
    expect(rows[0]?.billingMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(rows[4]?.receiptUrl).toBe("https://example.com/c1");
    expect(rows[5]?.receiptUrl).toBe("https://example.com/r1");
    expect(rows.every((x) => /^\d{4}-\d{2}$/.test(x.billingMonth))).toBe(true);
    // 기존 payments 배열은 구독료 청구만(예정·충전 없음)
    expect(r.body.payments).toHaveLength(3);
  });

  it("해지 예약·연체 중이면 예정 행이 없다", async () => {
    const canceled = await shop({ cancel: true });
    expect((await view(canceled.cookie)).body.billingRows).toEqual([]);
    await resetDb();
    const s = await shop();
    await db.sellerSubscription.update({ where: { id: s.sub.id }, data: { status: "PAST_DUE", currentPeriodEnd: ago(DAY) } });
    expect((await view(s.cookie)).body.billingRows).toEqual([]);
  });

  it("다른 쇼핑몰의 청구·충전은 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await pay(b, { createdAt: ago(DAY), paidAt: ago(DAY), amount: 1234 });
    await charge(b, { amount: 7777 });
    const rows = (await view(a.cookie)).body.billingRows as { amount: number }[];
    expect(rows.map((x) => x.amount)).toEqual([179000]);
  });
});

describe("청구 내역 내보내기 GET /api/seller/subscription/payments/export", () => {
  const exp = (cookie?: string) => exportGet(new Request("http://localhost:3000/api/seller/subscription/payments/export", { headers: { ...H, ...(cookie ? { cookie } : {}) } }));

  it("BOM CSV로 청구월·항목·금액·결제일·상태를 주고(예정 행 제외), 내려받은 사실을 로그 추적에 남긴다", async () => {
    const s = await shop();
    await pay(s, { createdAt: new Date("2026-09-10T00:05:00+09:00"), paidAt: new Date("2026-09-10T00:05:00+09:00"), periodStart: new Date("2026-09-10T00:05:00+09:00") });
    await charge(s, { createdAt: new Date("2026-10-01T10:02:00+09:00"), finishedAt: new Date("2026-10-01T10:02:00+09:00") });
    const res = await exp(s.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM(엑셀에서 한글이 깨지지 않게)
    const text = new TextDecoder("utf-8").decode(bytes);
    expect(text.startsWith("청구월,항목,금액,결제일,상태")).toBe(true);
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("2026.10,발송·이용 충전,10000,2026.10.01 10:02,결제 완료");
    expect(lines[2]).toBe("2026.09,월 구독,179000,2026.09.10 00:05,결제 완료");
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "billing.export" } })).toBe(1);
  });

  it("로그인 없으면 401, 직원(대표자 아님)은 403, 다른 쇼핑몰 값은 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await charge(b, { amount: 7777 });
    expect((await exp()).status).toBe(401);
    const staff = await createSellerUser(a.seller.id, "MANAGER");
    expect((await exp(await cookieOf(staff.email))).status).toBe(403);
    expect(await (await exp(a.cookie)).text()).not.toContain("7777");
  });
});
