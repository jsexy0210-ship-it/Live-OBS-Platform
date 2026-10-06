import { describe, expect, it } from "vitest";
import { activeQuick, addDays, addMonths, daysBetween, formatDateInput, monthGrid, parseDateInput, parseTimeInput, quickRange, recentRange, todayKst } from "../../lib/client/dateInput";
import { retypeMatches } from "../../components/admin-ui/confirmUtil";

// 공통 날짜 선택(DS-DATEPICKER) 순수 로직: 입력 읽기·표시·달력 격자·기간 계산·기본 기간(최근 1개월)
describe("날짜 입력 읽기·표시", () => {
  it("여러 구분자와 붙여 쓴 숫자를 같은 날짜로 읽고, 없는 날짜는 거른다", () => {
    expect(parseDateInput("2026-10-05")).toBe("2026-10-05");
    expect(parseDateInput("2026.10.05")).toBe("2026-10-05");
    expect(parseDateInput("2026/10/5")).toBe("2026-10-05");
    expect(parseDateInput("20261005")).toBe("2026-10-05");
    expect(parseDateInput("2026.10.05.")).toBe("2026-10-05");
    expect(parseDateInput("2026-02-30")).toBeNull();
    expect(parseDateInput("2026-13-01")).toBeNull();
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("abc")).toBeNull();
  });
  it("표시는 연.월.일", () => {
    expect(formatDateInput("2026-10-05")).toBe("2026.10.05");
    expect(formatDateInput("")).toBe("");
  });
  it("시각 입력", () => {
    expect(parseTimeInput("22:25")).toBe("22:25");
    expect(parseTimeInput("2225")).toBe("22:25");
    expect(parseTimeInput("9:5")).toBe("09:05");
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("12:60")).toBeNull();
  });
});

describe("달력·기간 계산", () => {
  it("달력은 일요일 시작 6주이고 이번 달 밖 날짜가 표시된다(2026년 10월 = 목요일 시작)", () => {
    const g = monthGrid(2026, 10);
    expect(g).toHaveLength(6);
    expect(g[0].map((c) => c.iso)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(g[0].map((c) => c.inMonth)).toEqual([false, false, false, false, true, true, true]);
    expect(g[5][6].iso).toBe("2026-11-07");
  });
  it("달 이동은 말일을 넘지 않는다", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-10-05", -1)).toBe("2026-09-05");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(daysBetween("2026-09-06", "2026-10-05")).toBe(29);
  });
  it("한국 시간 오늘 경계", () => {
    expect(todayKst(new Date("2026-10-05T14:59:00Z"))).toBe("2026-10-05");
    expect(todayKst(new Date("2026-10-05T15:00:00Z"))).toBe("2026-10-06");
  });
});

describe("검색 필터 기본 기간", () => {
  const now = new Date("2026-10-05T03:00:00Z");
  it("최근 1개월은 오늘 포함 한 달(09/06 ~ 10/05), 3개월·7일·오늘·전체", () => {
    expect(recentRange(1, now)).toEqual({ from: "2026-09-06", to: "2026-10-05" });
    expect(quickRange("3m", now)).toEqual({ from: "2026-07-06", to: "2026-10-05" });
    expect(quickRange("7d", now)).toEqual({ from: "2026-09-29", to: "2026-10-05" });
    expect(quickRange("today", now)).toEqual({ from: "2026-10-05", to: "2026-10-05" });
    expect(quickRange("all", now)).toEqual({ from: "", to: "" });
  });
  it("지금 기간이 어느 빠른 선택인지 알려 준다", () => {
    expect(activeQuick({ from: "2026-09-06", to: "2026-10-05" }, now)).toBe("1m");
    expect(activeQuick({ from: "", to: "" }, now)).toBe("all");
    expect(activeQuick({ from: "2026-01-01", to: "2026-01-02" }, now)).toBeNull();
  });
});

// 확인 창 이름 다시 입력(검수 후속): 이름 모드는 쉼표·「원」을 무시하지 않는다
describe("확인 창 다시 입력 모드", () => {
  it("금액 모드는 쉼표·원·공백을 무시하고, 이름 모드는 공백만 무시한다", () => {
    expect(retypeMatches("24,000원", "24000", "amount")).toBe(true);
    expect(retypeMatches("박원", "박", "text")).toBe(false);
    expect(retypeMatches("박 원", "박원", "text")).toBe(true);
    expect(retypeMatches("원", "원", "text")).toBe(true);
    expect(retypeMatches("", "원", "text")).toBe(false);
  });
});
