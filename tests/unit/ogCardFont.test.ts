import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import RANGES from "../../lib/server/shop/wantedSansRanges.json";

// 기본 공유 카드(lib/server/shop/ogCard.ts)가 쓰는 서체 파일별 글자 범위표가 화면 서체 정의(styles/wanted-sans.css)와 같아야 한다.
// 서체 파일을 바꾸면 범위표도 다시 만든다(이 시험이 어긋남을 잡는다).
describe("공유 카드 서체 범위표", () => {
  it("styles/wanted-sans.css의 unicode-range와 같다", () => {
    const css = readFileSync("styles/wanted-sans.css", "utf8");
    const fromCss = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].flatMap((m) => {
      const n = /split\.(\d+)\.woff2/.exec(m[1]);
      const r = /unicode-range:([^;}]*)/.exec(m[1]);
      if (!n || !r) return [];
      const ranges = r[1].split(",").map((s) => {
        const [a, z] = s.trim().replace(/^U\+/i, "").split("-");
        return [parseInt(a, 16), parseInt(z ?? a, 16)];
      });
      return [[Number(n[1]), ranges]];
    });
    expect(fromCss.length).toBe(92);
    expect(RANGES).toEqual(fromCss);
  });
});
