import { describe, expect, it } from "vitest";
import { proration } from "../../lib/server/billing/planChange";

// 상위 변경 차액(MASTER 결정 2026-10-04): KST 달력 날짜 기준 남은 일수 ÷ 기간 일수 × 차액, 원 단위 절사
describe("남은 기간 차액(KST 일 단위)", () => {
  // 기간 10/12 09:00 KST ~ 11/11 09:00 KST(30일), 차액 110,000원
  const start = new Date("2026-10-12T00:00:00Z");
  const end = new Date("2026-11-11T00:00:00Z");

  it("10일 남음 → 110,000 × 10/30 = 36,666원", () => {
    expect(proration(110000, start, end, new Date("2026-11-01T00:00:00Z"))).toEqual({ amount: 36666, remainingDays: 10 });
  });

  it("결제일 전날은 1일분, 결제일 당일은 0일(차액 없음)", () => {
    expect(proration(110000, start, end, new Date("2026-11-10T14:59:00Z"))).toEqual({ amount: 3666, remainingDays: 1 }); // 11/10 23:59 KST
    expect(proration(110000, start, end, new Date("2026-11-10T15:00:00Z"))).toEqual({ amount: 0, remainingDays: 0 }); // 11/11 00:00 KST
  });

  it("날짜는 UTC가 아니라 KST로 센다(UTC 11/9 15:30 = KST 11/10 00:30 → 1일)", () => {
    expect(proration(110000, start, end, new Date("2026-11-09T15:30:00Z")).remainingDays).toBe(1);
  });

  it("같은 날 안에서는 시각이 달라도 금액이 같고, 기간 첫날은 전부, 차액이 0 이하이면 0원", () => {
    expect(proration(110000, start, end, new Date("2026-10-12T00:00:00Z"))).toEqual({ amount: 110000, remainingDays: 30 });
    expect(proration(110000, start, end, new Date("2026-10-31T15:00:00Z")).amount).toBe(proration(110000, start, end, new Date("2026-11-01T14:59:00Z")).amount);
    expect(proration(-1000, start, end, new Date("2026-11-01T00:00:00Z")).amount).toBe(0);
  });
});
