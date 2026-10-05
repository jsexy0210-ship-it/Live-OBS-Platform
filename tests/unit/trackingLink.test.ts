import { describe, expect, it } from "vitest";
import { trackingUrl } from "../../components/shop/trackingLink";

describe("배송조회 링크(택배사 조회 페이지)", () => {
  it("택배사 코드와 송장번호로 링크를 만든다(하이픈·공백은 뺀다)", () => {
    expect(trackingUrl("CJ", "1234-5678-9012")).toBe("https://trace.cjlogistics.com/next/tracking.html?wblNo=123456789012");
    expect(trackingUrl("EPOST", "1234567890123")).toContain("sid1=1234567890123");
    for (const c of ["HANJIN", "LOTTE", "LOGEN"]) expect(trackingUrl(c, "123456789012")).toContain("123456789012");
  });
  it("모르는 택배사나 숫자가 아닌 송장은 링크를 주지 않는다", () => {
    expect(trackingUrl("UNKNOWN", "123456789012")).toBeNull();
    expect(trackingUrl("CJ", "abc123")).toBeNull();
    expect(trackingUrl("CJ", "123?x=1&y")).toBeNull();
  });
});
