import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDateTimeParts, formatTime } from "../../lib/client/format";
import { confirmButtonWidth, normalizeRetype, retypeMatches } from "../../components/admin-ui/confirmUtil";

// 공용 일시 서식: 연월일+시분 한 형식, 한국 시간(KST)·24시간제
describe("공용 일시 서식(2026.10.05 22:25)", () => {
  it("UTC 값을 한국 시간으로 바꿔 한 형식으로 보인다", () => {
    expect(formatDateTime("2026-10-05T13:25:00Z")).toBe("2026.10.05 22:25");
    expect(formatDateTime(new Date("2026-10-05T13:25:59Z"))).toBe("2026.10.05 22:25");
  });
  it("날짜가 한국 시간에서 하루 넘어가는 경계를 맞춘다", () => {
    expect(formatDateTime("2026-12-31T15:00:00Z")).toBe("2027.01.01 00:00");
    expect(formatDateTime("2026-10-05T14:59:00Z")).toBe("2026.10.05 23:59");
  });
  it("24시간제로 오전·오후 글자 없이 보인다", () => {
    expect(formatDateTime("2026-10-05T03:05:00Z")).toBe("2026.10.05 12:05");
    expect(formatDateTime("2026-10-04T15:00:00Z")).toBe("2026.10.05 00:00");
  });
  it("날짜만·시각만·두 줄 조각을 같은 기준으로 돌려준다", () => {
    expect(formatDate("2026-10-05T13:25:00Z")).toBe("2026.10.05");
    expect(formatTime("2026-10-05T13:25:00Z")).toBe("22:25");
    expect(formatDateTimeParts("2026-10-05T13:25:00Z")).toEqual({ date: "2026.10.05", time: "22:25" });
  });
  it("값이 없거나 잘못되면 대체 문구를 돌려준다", () => {
    expect(formatDateTime(null)).toBe("");
    expect(formatDateTime(undefined, "-")).toBe("-");
    expect(formatDateTime("not-a-date", "-")).toBe("-");
    expect(formatDate("", "-")).toBe("-");
    expect(formatDateTimeParts(null)).toBeNull();
  });
});

describe("공통 확인 창 도우미", () => {
  it("금액·이름 다시 입력은 공백·쉼표·원을 빼고 비교한다", () => {
    expect(normalizeRetype(" 24,000 원 ")).toBe("24000");
    expect(retypeMatches("24,000원", "24000")).toBe(true);
    expect(retypeMatches("24000", "24,000원")).toBe(true);
    expect(retypeMatches("24001", "24000")).toBe(false);
    expect(retypeMatches("", "24000")).toBe(false);
    expect(retypeMatches("별빛 카드숍", "별빛카드숍")).toBe(true);
  });
  it("기대값이 비어 있으면 어떤 입력도 일치로 보지 않는다", () => {
    expect(retypeMatches("", "")).toBe(false);
    expect(retypeMatches("1", "")).toBe(false);
  });
  it("버튼 폭은 기본 96, 실행 이름이 길면 두 버튼 모두 120", () => {
    expect(confirmButtonWidth("취소", "저장")).toBe("btn-w-md");
    expect(confirmButtonWidth("취소", "5건 변경")).toBe("btn-w-md");
    expect(confirmButtonWidth("취소", "숨김으로 변경")).toBe("btn-w-lg");
  });
});
