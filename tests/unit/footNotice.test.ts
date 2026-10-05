import { describe, expect, it } from "vitest";
import { HOSTING_PROVIDER, noticeRows } from "../../components/shop/footNotice";
import { bizInfoUrl, BIZ_INFO_URL } from "../../lib/server/shop-legal/notice";

// 쇼핑몰 바닥글 법정 표시 행: 입력한 항목만 행으로 만들고, 사업자정보 확인 링크는 10자리 사업자등록번호일 때만, 호스팅 제공은 늘 표시.
const EMPTY = { address: "", csPhone: "", csEmail: "", csHours: "", escrowKind: "none" as const, escrowProvider: "", escrowUrl: "" };

describe("noticeRows", () => {
  it("아무것도 입력하지 않으면 호스팅 제공만 보인다(사업자번호가 없으면 확인 링크도 없음)", () => {
    expect(noticeRows(null, EMPTY)).toEqual([{ label: "호스팅 제공", value: HOSTING_PROVIDER }]);
  });

  it("입력한 항목만 순서대로: 주소 → 고객센터(전화·운영시간) → 이메일 → 사업자정보 확인 → 호스팅 → 구매안전서비스", () => {
    const rows = noticeRows("1234567890", { ...EMPTY, address: "서울", csPhone: "1588-1234", csHours: "평일 10~17시", csEmail: "cs@example.com", escrowKind: "insurance", escrowProvider: "보험사", escrowUrl: "https://ins.example.com/x" });
    expect(rows).toEqual([
      { label: "주소", value: "서울" },
      { label: "고객센터", value: "1588-1234 · 평일 10~17시" },
      { label: "이메일", value: "cs@example.com" },
      { label: "사업자정보", value: "확인하기", href: BIZ_INFO_URL + "1234567890" },
      { label: "호스팅 제공", value: HOSTING_PROVIDER },
      { label: "구매안전서비스", value: "소비자피해보상보험 가입 · 보험사", href: "https://ins.example.com/x" },
    ]);
  });

  it("고객센터는 전화나 운영시간 중 하나만 있어도 보이고, 구매안전서비스는 가입 종류와 업체가 모두 있어야 보인다", () => {
    expect(noticeRows(null, { ...EMPTY, csHours: "평일 10~17시" })[0]).toEqual({ label: "고객센터", value: "평일 10~17시" });
    expect(noticeRows(null, { ...EMPTY, escrowKind: "escrow", escrowProvider: "" }).some((r) => r.label === "구매안전서비스")).toBe(false);
    expect(noticeRows(null, { ...EMPTY, escrowKind: "none", escrowProvider: "시험결제", escrowUrl: "https://a.example.com" }).some((r) => r.label === "구매안전서비스")).toBe(false);
    expect(noticeRows(null, { ...EMPTY, escrowKind: "escrow", escrowProvider: "시험결제" }).find((r) => r.label === "구매안전서비스")).toEqual({ label: "구매안전서비스", value: "에스크로 가입 · 시험결제", href: undefined });
  });
});

describe("bizInfoUrl", () => {
  it("숫자 10자리만 주소로 만든다(하이픈·짧은 값·숫자 아님·비문자열은 null)", () => {
    expect(bizInfoUrl("1234567890")).toBe(BIZ_INFO_URL + "1234567890");
    for (const v of ["123-45-67890", "123456789", "12345678901", "abcdefghij", "", null, undefined, 1234567890]) expect(bizInfoUrl(v), String(v)).toBeNull();
  });
});
