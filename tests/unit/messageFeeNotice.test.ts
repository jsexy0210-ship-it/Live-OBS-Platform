import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MESSAGE_FEE_NOTICE, messagePriceNotice } from "../../components/seller/messageFeeNotice";

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

describe("요금표 단가 표시", () => {
  it("미확정 단가는 단위나 부분 가격 문장 없이 안내한다", () => {
    expect(messagePriceNotice("1통당 [확정 전]원")).toBe("단가 확정 후 안내");
    expect(messagePriceNotice("1건당 10원(긴 문자는 [확정 전]원)")).toBe("단가 확정 후 안내");
  });
  it("확정된 0원과 유료 단가는 변경하지 않는다", () => {
    expect(messagePriceNotice("1통당 0원")).toBe("1통당 0원");
    expect(messagePriceNotice("1통당 1,000원")).toBe("1통당 1,000원");
  });
});
