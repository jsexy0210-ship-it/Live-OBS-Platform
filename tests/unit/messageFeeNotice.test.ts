import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGE_FEE_NOTICE } from "../../components/seller/messageFeeNotice";

// 화면의 비용 안내 문구는 서식(docs/terms/SELLER_MESSAGE_FEE_NOTICE.md)이 정본이다. 서식을 고치면 이 시험이 알려 준다.
const md = readFileSync("docs/terms/SELLER_MESSAGE_FEE_NOTICE.md", "utf8");
const body = md.slice(md.indexOf("## 1. "), md.indexOf("## 구현 조건"));

describe("발송 비용 안내 문구가 서식과 같다", () => {
  it("1~7절 제목과 항목이 서식과 한 글자도 다르지 않다", () => {
    const sections = body.split(/\n(?=## \d+\. )/).map((s) => {
      const m = s.match(/^## (\d+)\. (.+)/)!;
      const items = s
        .split("\n")
        .slice(1)
        .filter((l) => !l.startsWith("|"))
        .map((l) => l.match(/^(?:- |\d+\. )(.*)$/))
        .filter((m2): m2 is RegExpMatchArray => !!m2)
        .map((m2) => m2[1].trim());
      return { n: Number(m[1]), title: m[2].trim(), items };
    });
    expect(MESSAGE_FEE_NOTICE).toEqual(sections);
  });

  it("서식의 7개 절이 모두 있다", () => {
    expect(MESSAGE_FEE_NOTICE.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
