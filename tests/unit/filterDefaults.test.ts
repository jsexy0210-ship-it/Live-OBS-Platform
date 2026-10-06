import { describe, expect, it } from "vitest";
import { listDefaults } from "../../lib/client/filterDefaults";

describe("listDefaults", () => {
  const now = new Date("2026-10-06T03:00:00Z");
  it("기본: 최근 1개월 · 최신순 · 20", () => {
    expect(listDefaults({ q: "" }, { now })).toEqual({ from: "2026-09-07", to: "2026-10-06", sort: "latest", size: "20", q: "" });
  });
  it("기간 없음·3개월·extra 우선", () => {
    expect(listDefaults({ status: "" }, { period: null })).toEqual({ sort: "latest", size: "20", status: "" });
    expect(listDefaults({}, { period: 3, now }).from).toBe("2026-07-07");
    expect(listDefaults({ size: "50" }, { now }).size).toBe("50");
  });
});
