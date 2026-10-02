import { describe, expect, it } from "vitest";
import { FakeBusinessStatusProvider, FakeMailOrderProvider, normalizeBusinessNumber, normalizeMailOrderNumber, normalizeOpenedOn } from "../../lib/server/sellers/businessCheck";

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

describe("개업일자", () => {
  it("YYYYMMDD·YYYY-MM-DD를 받아 YYYYMMDD로, 없는 날짜는 거부", () => {
    expect(normalizeOpenedOn("2020-01-01")).toBe("20200101");
    expect(normalizeOpenedOn("20200101")).toBe("20200101");
    expect(normalizeOpenedOn("2020.02.29")).toBe("20200229");
    expect(normalizeOpenedOn("2019-02-29")).toBeNull();
    expect(normalizeOpenedOn("2020-13-01")).toBeNull();
    expect(normalizeOpenedOn("")).toBeNull();
  });
});

describe("가짜 조회", () => {
  it("운영 환경에서는 만들 수 없다", () => {
    expect(() => new FakeBusinessStatusProvider("production")).toThrow();
    expect(() => new FakeMailOrderProvider("production")).toThrow();
  });

  it("국세청 진위확인: 등록된 대표자명·개업일과 다르면 불일치", async () => {
    const p = new FakeBusinessStatusProvider("test");
    p.register("1248100998", { representativeName: "김대표", openedOn: "20200101" });
    expect(await p.verify({ businessNumber: "1248100998", representativeName: "김대표", openedOn: "20200101" })).toEqual({ ok: true, valid: true, status: "ACTIVE" });
    expect(await p.verify({ businessNumber: "1248100998", representativeName: "이아무개", openedOn: "20200101" })).toMatchObject({ valid: false });
    expect(await p.verify({ businessNumber: "1248100998", representativeName: "김대표", openedOn: "20200102" })).toMatchObject({ valid: false });
  });
});
