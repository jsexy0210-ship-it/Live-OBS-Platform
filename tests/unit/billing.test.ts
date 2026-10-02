import { describe, expect, it } from "vitest";
import { CHARGE_WAIT_MS, addOneMonth, sellerAccess, type AccessInput } from "../../lib/server/billing/access";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { openBillingKey, sealBillingKey } from "../../lib/server/billing/secret";

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
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ currentPeriodEnd: earlier }) }, now)).toBe("expired");
    expect(sellerAccess({ trialEndsAt: null, subscription: null }, now)).toBe("expired");
    // 경계: 종료 시각과 같으면 끝난 것
    expect(sellerAccess({ trialEndsAt: now, subscription: null }, now)).toBe("expired");
  });

  it("자동결제 실패·해지 예약이어도 결제한 기간 끝까지는 쓸 수 있다", () => {
    expect(sellerAccess({ trialEndsAt: null, subscription: sub({ status: "PAST_DUE", currentPeriodEnd: later }) }, now)).toBe("paid");
    expect(sellerAccess({ trialEndsAt: null, subscription: sub({ cancelAtPeriodEnd: true, currentPeriodEnd: later }) }, now)).toBe("paid");
  });

  it("자동결제 실패 뒤 유예 중에는 쓸 수 있고, 유예가 끝나면 잠긴다", () => {
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "PAST_DUE", graceUntil: later }) }, now)).toBe("grace");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "PAST_DUE", graceUntil: earlier }) }, now)).toBe("expired");
  });

  it("예약 결제 시각이 막 지났으면(예약 실행 대기) 하루까지는 끊지 않는다. 해지했으면 잠긴다", () => {
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ nextChargeAt: earlier }) }, now)).toBe("charging");
    const old = new Date(now.getTime() - CHARGE_WAIT_MS - 1);
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ nextChargeAt: old }) }, now)).toBe("expired");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ nextChargeAt: earlier, cancelAtPeriodEnd: true }) }, now)).toBe("expired");
    expect(sellerAccess({ trialEndsAt: earlier, subscription: sub({ status: "CANCELED", nextChargeAt: earlier }) }, now)).toBe("expired");
  });
});

describe("한 달 뒤", () => {
  it("같은 날·시각, 없는 날은 그 달 마지막 날", () => {
    expect(addOneMonth(new Date("2026-10-02T03:00:00Z")).toISOString()).toBe("2026-11-02T03:00:00.000Z");
    expect(addOneMonth(new Date("2027-01-31T15:00:00Z")).toISOString()).toBe("2027-02-28T15:00:00.000Z");
    expect(addOneMonth(new Date("2028-01-31T00:00:00Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addOneMonth(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
});

describe("빌링키 암호화", () => {
  it("원문이 남지 않고, 풀면 같은 값, 위조하면 실패, 비밀키가 없으면 오류", () => {
    process.env.BILLING_KEY_SECRET = "unit-billing-key-secret-0123456789abcdef";
    const sealed = sealBillingKey("bk_live_abc");
    expect(sealed).not.toContain("bk_live_abc");
    expect(sealBillingKey("bk_live_abc")).not.toBe(sealed);
    expect(openBillingKey(sealed)).toBe("bk_live_abc");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => openBillingKey(parts.join("."))).toThrow();
    process.env.BILLING_KEY_SECRET = "short";
    expect(() => sealBillingKey("x")).toThrow();
  });
});

describe("가짜 결제 공급자", () => {
  it("운영 환경에서는 만들 수 없다", () => {
    expect(() => new FakeBillingProvider("production")).toThrow();
  });
});
