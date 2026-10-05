import { describe, expect, it } from "vitest";
import { kstMonthKey, nextMonthStart, nextRank, parseMinAmount, targetRank, thresholdsIncrease, windowStart } from "../../lib/server/shop-member-grades/rules";

describe("회원 등급 규칙", () => {
  const t = [0, 100_000, 500_000, 1_000_000];
  it("목표 등급은 기준액 이상인 가장 높은 등급이다(경계 포함)", () => {
    expect(targetRank(t, 0)).toBe(0);
    expect(targetRank(t, 99_999)).toBe(0);
    expect(targetRank(t, 100_000)).toBe(1);
    expect(targetRank(t, 999_999)).toBe(2);
    expect(targetRank(t, 5_000_000)).toBe(3);
  });
  it("승급은 목표까지 한 번에, 강등은 한 단계씩, 같으면 그대로", () => {
    expect(nextRank(0, 3)).toBe(3);
    expect(nextRank(3, 0)).toBe(2);
    expect(nextRank(1, 1)).toBe(1);
    expect(nextRank(2, 1)).toBe(1);
  });
  it("기준액은 첫 등급 0, 이후 엄격히 커야 한다", () => {
    expect(thresholdsIncrease([0, 1, 2])).toBe(true);
    expect(thresholdsIncrease([0, 0, 5])).toBe(false);
    expect(thresholdsIncrease([5, 10])).toBe(false);
    expect(thresholdsIncrease([0, 10, 5])).toBe(false);
    expect(thresholdsIncrease([])).toBe(true);
  });
  it("기준액 입력은 0 이상의 정수만", () => {
    expect(parseMinAmount(0)).toBe(0);
    expect(parseMinAmount(1.5)).toBeNull();
    expect(parseMinAmount(-1)).toBeNull();
    expect(parseMinAmount("100")).toBeNull();
    expect(parseMinAmount(2_000_000_001)).toBeNull();
  });
  it("달 키와 다음 재산정 시각은 KST 기준이다(UTC 15시가 KST 다음 날 0시)", () => {
    expect(kstMonthKey(new Date("2026-10-31T14:59:59Z"))).toBe("2026-10");
    expect(kstMonthKey(new Date("2026-10-31T15:00:00Z"))).toBe("2026-11");
    expect(nextMonthStart(new Date("2026-10-15T00:00:00Z")).toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(nextMonthStart(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe("2026-12-31T15:00:00.000Z"); // 12월 → 다음 해 1월 1일 0시(KST)
    expect(nextMonthStart(new Date("2026-12-31T15:00:00Z")).toISOString()).toBe("2027-01-31T15:00:00.000Z"); // 이미 1월 1일(KST)이면 2월 1일
  });
  it("기준 기간은 6개월 전부터", () => {
    expect(windowStart(new Date("2026-11-01T00:00:00Z")).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
