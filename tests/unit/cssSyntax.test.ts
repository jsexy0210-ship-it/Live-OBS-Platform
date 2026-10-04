import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 스타일 파일 구문 검사: 블록 중괄호가 짝이 맞는지 본다(주석·문자열 안의 중괄호는 빼고 센다).
// 충돌 해결 중 @media를 닫지 않으면 그 뒤 규칙이 모두 좁은 화면에서만 적용되는데, 빌드는 그대로 통과해서 놓치기 쉽다.
const STYLES = join(__dirname, "../../styles");

function braceProblem(css: string): string | null {
  let depth = 0;
  let line = 1;
  const openedAt: number[] = [];
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "\n") line++;
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) return `${line}행: 닫히지 않은 주석`;
      line += css.slice(i, end).split("\n").length - 1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "{") {
      depth++;
      openedAt.push(line);
    } else if (c === "}") {
      depth--;
      openedAt.pop();
      if (depth < 0) return `${line}행: 여는 중괄호 없이 닫음`;
    }
  }
  return depth === 0 ? null : `${openedAt[openedAt.length - 1]}행에서 연 블록이 닫히지 않음`;
}

describe("스타일 파일 구문", () => {
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
    it(`${file}: 블록 중괄호 짝이 맞다`, () => {
      expect(braceProblem(readFileSync(join(STYLES, file), "utf8"))).toBeNull();
    });
  }

  it("닫지 않은 @media·여분의 닫는 중괄호를 찾고, 주석·문자열 안의 중괄호는 세지 않는다", () => {
    expect(braceProblem("@media (max-width: 1px) {\n  .a {\n    color: red;\n  }\n\n.b {\n}\n")).toBe("1행에서 연 블록이 닫히지 않음");
    expect(braceProblem(".a {\n}\n}\n")).toBe("3행: 여는 중괄호 없이 닫음");
    expect(braceProblem('/* { */\n.a { content: "}"; }\n')).toBeNull();
  });
});
