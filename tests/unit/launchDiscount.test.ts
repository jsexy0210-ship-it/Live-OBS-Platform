import { describe, expect, it } from "vitest";
import { launchDiscountEligible, launchDiscountEndsAt } from "../../lib/server/billing/access";

describe("계정 첫 할인 결제부터 KST 달력 3개월", () => {
  it.each([
    ["2026-01-31T23:45:12.123+09:00", "2026-04-30T23:45:12.123+09:00"],
    ["2023-11-30T00:05:00+09:00", "2024-02-29T00:05:00+09:00"],
    ["2026-11-30T00:05:00+09:00", "2027-02-28T00:05:00+09:00"],
    ["2026-07-31T15:30:00Z", "2026-10-31T15:30:00Z"],
    ["2026-08-30T15:30:00Z", "2026-11-29T15:30:00Z"],
  ])("%s부터 %s까지이며 종료 시각에는 정가", (start, end) => {
    const usedAt = new Date(start);
    const endsAt = new Date(end);
    expect(launchDiscountEndsAt(usedAt)).toEqual(endsAt);
    expect(launchDiscountEligible(usedAt, new Date(endsAt.getTime() - 1))).toBe(true);
    expect(launchDiscountEligible(usedAt, endsAt)).toBe(false);
    expect(launchDiscountEligible(usedAt, new Date(endsAt.getTime() + 1))).toBe(false);
  });

  it("첫 성공 전에는 가입이나 카드 등록 뒤 얼마나 지났든 혜택이 만료되지 않는다", () => {
    expect(launchDiscountEndsAt(null)).toBeNull();
    expect(launchDiscountEligible(null, new Date("2999-01-01"))).toBe(true);
  });
});
