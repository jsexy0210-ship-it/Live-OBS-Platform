import { afterEach, describe, expect, it } from "vitest";
import { addMonthsKst, lockedSince, nextPeriodEnd, sellerAccess, type AccessInput } from "../../lib/server/billing/access";
import { FAKE_BILLING_CHARGES_KEEP, FAKE_BILLING_RESULTS_KEEP, FakeBillingProvider } from "../../lib/server/billing/provider";
import { billingProvider } from "../../lib/server/billing/registry";
import { assertBillingSecret, openBillingKey, sealBillingKey } from "../../lib/server/billing/secret";

const now = new Date("2026-10-02T03:00:00Z");
const later = new Date(now.getTime() + 1000);
const earlier = new Date(now.getTime() - 1000);
const sub = (v: Partial<NonNullable<AccessInput["subscription"]>>): AccessInput["subscription"] => ({
  status: "ACTIVE",
  currentPeriodEnd: null,
  nextChargeAt: null,
  graceUntil: null,
  cancelAtPeriodEnd: false,
  ...v,
});

describe("이용 가능 여부", () => {
  it("체험하기 중 / 결제 기간 중 / 둘 다 끝남", () => {
    expect(sellerAccess({ trialEndsAt: later, subscription: null }, now)).toBe("trial");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ currentPeriodEnd: later }) }, now)).toBe("paid");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "CANCELED", currentPeriodEnd: earlier }) }, now)).toBe("expired");
    expect(sellerAccess({ trialEndsAt: null, subscription: null }, now)).toBe("expired");
    // 경계: 종료 시각과 같으면 끝난 것
    expect(sellerAccess({ trialEndsAt: now, subscription: null }, now)).toBe("expired");
  });

  it("자동결제 실패·해지 예약이어도 결제한 기간 끝까지는 쓸 수 있다", () => {
    expect(sellerAccess({ trialEndsAt: null, subscription: sub({ status: "PAST_DUE", currentPeriodEnd: later }) }, now)).toBe("paid");
    expect(sellerAccess({ trialEndsAt: null, subscription: sub({ cancelAtPeriodEnd: true, currentPeriodEnd: later }) }, now)).toBe("paid");
  });

  it("유예 중에는 쓸 수 있고, 유예가 끝나거나 해지 예약하면 잠긴다", () => {
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "PAST_DUE", graceUntil: later }) }, now)).toBe("grace");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "PAST_DUE", graceUntil: earlier }) }, now)).toBe("expired");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "PAST_DUE", graceUntil: later, cancelAtPeriodEnd: true }) }, now)).toBe("expired");
  });

  it("예약 결제 시각이 지났어도 예약 실행이 처리하기 전까지는(시간 제한 없이) 열어 둔다. 해지했으면 잠긴다", () => {
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ nextChargeAt: earlier }) }, now)).toBe("charging");
    const longAgo = new Date(now.getTime() - 10 * 86_400_000);
    expect(sellerAccess({ trialEndsAt: longAgo, subscription: sub({ nextChargeAt: longAgo }) }, now)).toBe("charging");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ nextChargeAt: earlier, cancelAtPeriodEnd: true }) }, now)).toBe("expired");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "CANCELED", nextChargeAt: earlier }) }, now)).toBe("expired");
  });
});

describe("잠기기 시작한 시각", () => {
  it("체험하기 끝·기간 끝·유예 끝 중 가장 늦은 시각", () => {
    const d = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(lockedSince({ trialEndsAt: d(-40), subscription: null })).toEqual(d(-40));
    expect(lockedSince({ trialEndsAt: d(-40), subscription: sub({ status: "PAST_DUE", currentPeriodEnd: d(-20), graceUntil: d(-13) }) })).toEqual(d(-13));
    expect(lockedSince({ trialEndsAt: d(-40), subscription: sub({ status: "CANCELED", currentPeriodEnd: d(-5) }) })).toEqual(d(-5));
    expect(lockedSince({ trialEndsAt: null, subscription: null })).toBeNull();
  });
});

describe("기간 계산 (KST 기준일)", () => {
  it("1/31 08:00 KST 기준이면 2/28 → 3/31 → 4/30, 시각은 08:00 KST 그대로", () => {
    const anchor = new Date("2027-01-30T23:00:00Z"); // 2027-01-31 08:00 KST
    expect(addMonthsKst(anchor, 1).toISOString()).toBe("2027-02-27T23:00:00.000Z"); // 2/28 08:00 KST
    expect(addMonthsKst(anchor, 2).toISOString()).toBe("2027-03-30T23:00:00.000Z"); // 3/31 08:00 KST
    expect(addMonthsKst(anchor, 3).toISOString()).toBe("2027-04-29T23:00:00.000Z"); // 4/30 08:00 KST
    // 기간 끝은 다음 기준일: 2/28 08:00 KST 기간 다음은 3/31 08:00 KST
    expect(nextPeriodEnd(anchor, addMonthsKst(anchor, 1)).toISOString()).toBe("2027-03-30T23:00:00.000Z");
  });

  it("UTC로는 전날이지만 KST로는 1일인 시각도 KST 날짜로 센다", () => {
    const anchor = new Date("2026-12-31T15:30:00Z"); // 2027-01-01 00:30 KST
    expect(addMonthsKst(anchor, 1).toISOString()).toBe("2027-01-31T15:30:00.000Z"); // 2027-02-01 00:30 KST
  });

  it("윤년 2월은 29일", () => {
    expect(addMonthsKst(new Date("2028-01-30T23:00:00Z"), 1).toISOString()).toBe("2028-02-28T23:00:00.000Z"); // 2028-02-29 08:00 KST
  });
});

describe("빌링키 암호화", () => {
  const prev = process.env.BILLING_KEY_SECRET;
  afterEach(() => {
    process.env.BILLING_KEY_SECRET = prev;
  });

  it("원문이 남지 않고, 같은 판매자로만 풀리며, 위조하면 실패한다", () => {
    process.env.BILLING_KEY_SECRET = "unit-billing-key-secret-0123456789abcdef";
    const sealed = sealBillingKey("bk_live_abc", "seller-a");
    expect(sealed).not.toContain("bk_live_abc");
    expect(sealBillingKey("bk_live_abc", "seller-a")).not.toBe(sealed);
    expect(openBillingKey(sealed, "seller-a")).toBe("bk_live_abc");
    // 다른 판매자 행으로 옮겨 붙이면 풀리지 않는다(AAD)
    expect(() => openBillingKey(sealed, "seller-b")).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => openBillingKey(parts.join("."), "seller-a")).toThrow();
  });

  it("비밀키가 없거나 짧으면 미리 실패한다", () => {
    process.env.BILLING_KEY_SECRET = "short";
    expect(() => assertBillingSecret()).toThrow();
    delete process.env.BILLING_KEY_SECRET;
    expect(() => sealBillingKey("x", "s")).toThrow();
  });
});

describe("결제 공급자 선택", () => {
  const prev = process.env.BILLING_PROVIDER;
  afterEach(() => {
    process.env.BILLING_PROVIDER = prev;
  });

  it("가짜 공급자는 BILLING_PROVIDER=fake를 명시했을 때만 쓰고, 운영 환경에서는 만들 수 없다", () => {
    delete process.env.BILLING_PROVIDER;
    expect(() => billingProvider()).toThrow();
    process.env.BILLING_PROVIDER = "nicepay";
    expect(() => billingProvider()).toThrow();
    process.env.BILLING_PROVIDER = "fake";
    expect(billingProvider().name).toBe("fake");
    expect(() => new FakeBillingProvider("production")).toThrow();
  });
});

describe("테스트 서버 모드의 가짜 결제 공급자 메모리", () => {
  const charge = (p: FakeBillingProvider, orderId: string) => p.charge({ orderId, amount: 1000, billingKey: "bk", customerKey: "c", orderName: "구독" });

  it("결제 결과는 최근 5000건, 결제 기록은 최근 1000건만 남기고, 남은 결과는 그대로 조회된다", async () => {
    const p = new FakeBillingProvider("production", { testMode: true });
    const n = FAKE_BILLING_RESULTS_KEEP + 300;
    for (let i = 0; i < n; i++) await charge(p, `o-${i}`);
    expect(p.resultCount).toBe(FAKE_BILLING_RESULTS_KEEP);
    expect(p.charges.length).toBe(FAKE_BILLING_CHARGES_KEEP);
    expect(await p.getPayment("o-0")).toEqual({ status: "NOT_FOUND" });
    expect((await p.getPayment(`o-${n - 1}`)).status).toBe("PAID");
    // 같은 주문 재요청은 기록을 늘리지 않고 같은 결제 번호
    expect(await charge(p, `o-${n - 1}`)).toEqual({ ok: true, paymentId: `fake-pay-o-${n - 1}`, receiptUrl: null });
  });

  it("개발·시험용(테스트 서버 모드가 아님)은 지우지 않는다", async () => {
    const p = new FakeBillingProvider("test");
    for (let i = 0; i < FAKE_BILLING_CHARGES_KEEP + 10; i++) await charge(p, `o-${i}`);
    expect(p.charges.length).toBe(FAKE_BILLING_CHARGES_KEEP + 10);
    expect(p.resultCount).toBe(FAKE_BILLING_CHARGES_KEEP + 10);
  });
});
