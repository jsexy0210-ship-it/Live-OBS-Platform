import { describe, expect, it } from "vitest";
import { EXTERNAL_API_MONTHLY_LIMIT_WON, monthlyLimitWon } from "../../lib/server/automation/budget";
import { publicError } from "../../lib/server/automation/jobs";

describe("외부 API 월 한도 설정", () => {
  it("기본은 1만 원, 낮추는 값만 받고 1만 원을 넘기거나 잘못된 값은 1만 원", () => {
    expect(monthlyLimitWon({})).toBe(EXTERNAL_API_MONTHLY_LIMIT_WON);
    expect(monthlyLimitWon({ EXTERNAL_API_MONTHLY_LIMIT_WON: "5000" })).toBe(5000);
    for (const v of ["10001", "0", "-1", "1.5", "abc", ""]) expect(monthlyLimitWon({ EXTERNAL_API_MONTHLY_LIMIT_WON: v })).toBe(EXTERNAL_API_MONTHLY_LIMIT_WON);
  });
  it("한도 정지 사유는 화면에 내보내는 코드다", () => {
    expect(publicError("budget_limit")).toBe("budget_limit");
  });
});
