import { describe, expect, it } from "vitest";
import { FakeBusinessStatusProvider, normalizeBusinessNumber, normalizeMailOrderNumber } from "../../lib/server/sellers/businessCheck";

describe("사업자등록번호", () => {
  it("하이픈·공백을 지우고 국세청 검증 숫자가 맞을 때만 받는다", () => {
    expect(normalizeBusinessNumber("124-81-00998")).toBe("1248100998");
    expect(normalizeBusinessNumber("220 81 62517")).toBe("2208162517");
    expect(normalizeBusinessNumber("124-81-00999")).toBeNull();
    expect(normalizeBusinessNumber("12481009")).toBeNull();
    expect(normalizeBusinessNumber("abcdefghij")).toBeNull();
  });
});

describe("통신판매업 신고번호", () => {
  it("「제2024-서울강남-01234호」 형식을 받아 표준 형태로 바꾼다", () => {
    expect(normalizeMailOrderNumber("제2024-서울강남-01234호")).toBe("제2024-서울강남-01234호");
    expect(normalizeMailOrderNumber("2024-서울강남-01234")).toBe("제2024-서울강남-01234호");
    expect(normalizeMailOrderNumber(" 제 2024-서울강남-01234 호 ")).toBe("제2024-서울강남-01234호");
    expect(normalizeMailOrderNumber("신고 준비 중")).toBeNull();
    expect(normalizeMailOrderNumber("2024-01234")).toBeNull();
  });
});

describe("가짜 사업자 조회", () => {
  it("운영 환경에서는 만들 수 없다", () => {
    expect(() => new FakeBusinessStatusProvider("production")).toThrow();
  });
});
