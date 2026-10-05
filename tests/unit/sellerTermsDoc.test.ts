import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SELLER_TERMS } from "../../components/public/sellerTerms";

// 화면의 파트너스 이용약관(PF-008)은 서식(docs/terms/SELLER_TERMS_TEMPLATE.md)이 정본이다. 서식을 고치면 이 시험이 알려 준다.
const md = readFileSync("docs/terms/SELLER_TERMS_TEMPLATE.md", "utf8");
const body = md.slice(md.indexOf("\n---\n") + 5).trim();

describe("파트너스 이용약관 문구가 서식과 같다", () => {
  it("조·항 문구가 서식과 한 글자도 다르지 않다", () => {
    const sections = body.split(/\n\n(?=제\d+조\(|부칙\n)/).map((b) => {
      const [heading, ...rest] = b.split("\n");
      return { heading: heading.trim(), lines: rest.map((l) => l.trim()).filter(Boolean) };
    });
    expect(SELLER_TERMS).toEqual(sections);
  });

  it("제1조부터 제12조와 부칙이 모두 있다", () => {
    expect(SELLER_TERMS.map((s) => s.heading.match(/^제(\d+)조/)?.[1] ?? s.heading)).toEqual([...Array.from({ length: 12 }, (_, i) => String(i + 1)), "부칙"]);
  });
});
