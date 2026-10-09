import { describe, expect, it } from "vitest";
import { elapsedDayRange, parseStatsRange } from "../../lib/server/stats/range";

describe("홈 어제 같은 시각 비교", () => {
  it("오늘과 어제 모두 KST 자정에서 같은 경과 시각까지만 조회한다", () => {
    const at = new Date("2026-10-06T16:23:45Z");
    const range = parseStatsRange({ from: "2026-10-07", to: "2026-10-07" })!;
    const actual = elapsedDayRange(range, at)!;
    expect(actual.start.toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(actual.end).toEqual(at);
    expect(actual.prev.start.toISOString()).toBe("2026-10-05T15:00:00.000Z");
    expect(actual.prev.end.toISOString()).toBe("2026-10-05T16:23:45.000Z");
    expect(range.end.toISOString()).toBe("2026-10-07T15:00:00.000Z");
  });
  it("KST 자정에서도 어제 전체를 비교에 넣지 않는다", () => {
    const at = new Date("2026-10-06T15:00:00Z");
    const actual = elapsedDayRange(parseStatsRange({ from: "2026-10-07", to: "2026-10-07" })!, at)!;
    expect(actual.start).toEqual(actual.end);
    expect(actual.prev.start).toEqual(actual.prev.end);
  });
  it("지난 날짜나 여러 날짜 요청은 홈 비교로 바꾸지 않는다", () => {
    const at = new Date("2026-10-06T16:00:00Z");
    expect(elapsedDayRange(parseStatsRange({ from: "2026-10-06", to: "2026-10-06" })!, at)).toBeNull();
    expect(elapsedDayRange(parseStatsRange({ from: "2026-10-06", to: "2026-10-07" })!, at)).toBeNull();
  });
});
