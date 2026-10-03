import { describe, expect, it } from "vitest";
import { kstAge } from "../../lib/server/buyers/signup";

const d = (s: string) => new Date(`${s}T00:00:00Z`); // DB date 값 형태(UTC 0시)

describe("kstAge: KST 날짜 기준 만 나이", () => {
  it("생일 당일에 한 살 많아지고 전날은 아니다", () => {
    expect(kstAge(d("2012-10-03"), new Date("2026-10-03T00:00:00+09:00"))).toBe(14);
    expect(kstAge(d("2012-10-03"), new Date("2026-10-02T23:59:59+09:00"))).toBe(13);
  });

  it("UTC로는 전날이어도 KST로 생일이면 생일로 본다", () => {
    // 2026-10-02T15:00Z = KST 10월 3일 0시
    expect(kstAge(d("2012-10-03"), new Date("2026-10-02T15:00:00Z"))).toBe(14);
    expect(kstAge(d("2012-10-03"), new Date("2026-10-02T14:59:59Z"))).toBe(13);
  });

  it("2월 29일생은 평년에는 3월 1일에 한 살 많아진다", () => {
    expect(kstAge(d("2012-02-29"), new Date("2026-02-28T12:00:00+09:00"))).toBe(13);
    expect(kstAge(d("2012-02-29"), new Date("2026-03-01T00:00:00+09:00"))).toBe(14);
    expect(kstAge(d("2012-02-29"), new Date("2028-02-29T00:00:00+09:00"))).toBe(16);
  });
});
