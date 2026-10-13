import { describe, expect, it } from "vitest";
import { publicCompanyParts } from "../../components/public/companyInfo";

describe("플랫폼 바닥글 설정 표시", () => {
  it("설정 부재·빈 문자열·공백만 있는 필드는 표시하지 않는다", () => {
    expect(publicCompanyParts()).toEqual([]);
    expect(publicCompanyParts(null)).toEqual([]);
    expect(publicCompanyParts({ name: " ", phone: "", address: null })).toEqual([]);
  });
  it("기존 6필드만 순서대로 표시하고 비어 있는 필드는 생략한다", () => {
    expect(publicCompanyParts({ name: " 시험 상호 ", representative: "합성 대표", businessNumber: "1234567890", mailOrderNumber: "", address: "합성 주소", phone: "합성 연락처" })).toEqual([
      "상호 시험 상호", "대표 합성 대표", "사업자등록번호 1234567890", "주소 합성 주소", "고객센터 합성 연락처",
    ]);
  });
});
