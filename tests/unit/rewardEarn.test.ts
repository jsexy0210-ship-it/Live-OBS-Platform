import { describe, expect, it } from "vitest";
import { earnAmount } from "../../lib/server/rewards/earn";

const now = new Date("2026-10-02T12:00:00Z");
const rates = { g1: { card: 1, bankTransfer: 3 } };

describe("적립금 지급액", () => {
  it("등급·결제수단별 적립률, 원 단위 내림", () => {
    expect(earnAmount({ rates, earnStartsAt: null, gradeId: "g1", paymentMethod: "CARD", base: 12345, now })).toBe(123);
    expect(earnAmount({ rates, earnStartsAt: null, gradeId: "g1", paymentMethod: "BANK_TRANSFER", base: 12345, now })).toBe(370);
  });

  it("지급 시작 전·적립률 없음·결제수단 없음·잘못된 값은 0", () => {
    expect(earnAmount({ rates, earnStartsAt: new Date(now.getTime() + 1), gradeId: "g1", paymentMethod: "CARD", base: 10000, now })).toBe(0);
    expect(earnAmount({ rates, earnStartsAt: null, gradeId: "other", paymentMethod: "CARD", base: 10000, now })).toBe(0);
    expect(earnAmount({ rates, earnStartsAt: null, gradeId: "g1", paymentMethod: null, base: 10000, now })).toBe(0);
    expect(earnAmount({ rates: { g1: { card: 150 } }, earnStartsAt: null, gradeId: "g1", paymentMethod: "CARD", base: 10000, now })).toBe(0);
    expect(earnAmount({ rates: "bad", earnStartsAt: null, gradeId: "g1", paymentMethod: "CARD", base: 10000, now })).toBe(0);
  });
});
