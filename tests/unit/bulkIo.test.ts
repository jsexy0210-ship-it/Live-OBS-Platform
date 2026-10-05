import { describe, expect, it } from "vitest";
import { formatCsv, guardText, parseCsv, unguardText } from "../../lib/server/shop-bulk-io/csv";
import { COLUMNS, MAX_IMPORT_ROWS, parseProductCsv, templateCsv } from "../../lib/server/shop-bulk-io/service";

// 엑셀(CSV) 일괄 등록(SA-018): CSV 읽기·쓰기와 행 검증(DB 없음)
const cats = new Map([["카드", ["c1"]], ["카드>부스터", ["c2"]], ["중복", ["c3", "c4"]]]);
const HEAD = COLUMNS.join(",");
const parse = (body: string, head = HEAD) => {
  const r = parseProductCsv(`${head}\r\n${body}`, cats);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

describe("CSV 읽기·쓰기", () => {
  it("BOM·CRLF·LF, 따옴표 안의 쉼표·줄바꿈·큰따옴표를 읽는다", () => {
    const r = parseCsv('﻿a,b\r\n"x,1","line1\nline2"\n"he said ""hi""",\n');
    expect(r).toEqual({ ok: true, rows: [["a", "b"], ["x,1", "line1\nline2"], ['he said "hi"', ""]] });
  });
  it("닫히지 않은 따옴표는 실패", () => {
    expect(parseCsv('a,"b')).toEqual({ ok: false, reason: "unterminated_quote" });
  });
  it("쓴 것을 그대로 다시 읽는다(BOM·CRLF 포함)", () => {
    const rows = [["상품명", "설명"], ["부스터, 팩", '따옴표 " 와\n줄바꿈'], ["", ""]];
    const text = formatCsv(rows);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("\r\n");
    expect(parseCsv(text)).toEqual({ ok: true, rows });
  });
  it("수식으로 읽히는 시작 글자는 작은따옴표를 붙이고 읽을 때 뗀다", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
      expect(guardText(v)).toBe(`'${v}`);
      expect(unguardText(guardText(v))).toBe(v);
    }
    expect(guardText("일반")).toBe("일반");
    expect(unguardText("'일반")).toBe("'일반");
  });
});

describe("상품 CSV 검증", () => {
  it("내려받는 양식은 그대로 올릴 수 있다(상품 2개, 옵션 3개)", () => {
    const r = parseProductCsv(templateCsv(), cats);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.errors).toEqual([]);
    expect(r.value.products.map((p) => [p.input.name, (p.input.options as unknown[]).length, p.categoryIds])).toEqual([["부스터 팩", 1, ["c2"]], ["슬리브 세트", 2, []]]);
  });
  it("상품명을 비운 줄은 앞 상품의 옵션, 숫자는 쉼표·원을 받는다", () => {
    const v = parse("A,\"12,000원\",판매중,,주문 시,카드|카드>부스터,빨강,500,3,R\r\n,,,,,,파랑,,,\r\nB,1000,,,,,,,,");
    expect(v.errors).toEqual([]);
    const [a, b] = v.products;
    expect(a.input).toMatchObject({ name: "A", price: 12000, status: "ON_SALE", stockDeductMode: "ORDER" });
    expect(a.input.options).toEqual([{ name: "빨강", priceDelta: 500, stock: 3, sku: "R" }, { name: "파랑", priceDelta: 0, stock: 0, sku: null }]);
    expect(a.categoryIds).toEqual(["c1", "c2"]);
    expect(b.input).toMatchObject({ name: "B", status: "DRAFT", stockDeductMode: "PAYMENT", options: [] });
  });
  it("오류가 있는 상품은 모든 줄을 건너뛰고 줄 번호(머리글=1)와 열을 알려 준다", () => {
    const v = parse("OK,1000,판매중,,,,기본,0,1,\r\nBAD,abc,판매중,,,,기본,0,1,\r\n,,,,,,옵션2,0,1,\r\nBAD2,1000,이상함,,,,기본,0,1,\r\nBAD3,1000,판매중,,,,,,,\r\nBAD4,1000,판매중,,,없는카테고리,기본,0,1,");
    expect(v.products.map((p) => p.input.name)).toEqual(["OK"]);
    expect(v.skippedProducts).toBe(4);
    expect(v.errors.map((e) => [e.row, e.column])).toEqual([[3, "판매가"], [5, "상태"], [6, null], [7, "카테고리"]]);
  });
  it("같은 상품의 같은 옵션명, 옵션 줄에 다른 상품 정보, 옵션명 없는 재고, 같은 이름 카테고리, 음수 재고", () => {
    const v = parse("A,1000,,,,,기본,0,1,\r\n,,,,,,기본,0,1,\r\nB,1000,,,,,기본,0,1,\r\n,2000,,,,,다른,0,1,\r\nC,1000,,,,,,0,5,\r\nD,1000,,,,중복,기본,0,1,\r\nE,1000,,,,,기본,0,-1,");
    expect(v.products).toEqual([]);
    expect(v.errors.map((e) => [e.row, e.column])).toEqual([[3, "옵션명"], [5, "판매가"], [6, "옵션명"], [7, "카테고리"], [8, "재고"]]);
  });
  it("맨 앞에 옵션만 있는 줄은 오류(상품이 없음)", () => {
    const v = parse(",,,,,,기본,0,1,\r\nA,1000,,,,,기본,0,1,");
    expect(v.errors).toEqual([expect.objectContaining({ row: 2, column: "상품명" })]);
    expect(v.products.map((p) => p.input.name)).toEqual(["A"]);
  });
  it("수식 방지로 붙은 작은따옴표는 떼고 읽는다", () => {
    const v = parse("'=이름,1000,,,,,기본,0,1,'-1");
    expect(v.products[0].input.name).toBe("=이름");
    expect((v.products[0].input.options as { sku: string }[])[0].sku).toBe("-1");
  });
  it("머리글·파일 형식 오류는 상품 오류가 아니라 파일 오류", () => {
    const fail = (t: string) => {
      const r = parseProductCsv(t, cats);
      return r.ok ? "ok" : r.reason;
    };
    expect(fail("")).toBe("invalid_header");
    expect(fail("상품명,가격\r\nA,1")).toBe("invalid_header");
    expect(fail("상품명,판매가,상품명\r\nA,1,B")).toBe("invalid_header");
    expect(fail("판매가\r\n1")).toBe("invalid_header");
    expect(fail(`${HEAD}\r\n`)).toBe("empty_file");
    expect(fail('상품명,판매가\r\n"A,1')).toBe("invalid_csv");
    expect(fail(`${HEAD}\r\n${"A,1\r\n".repeat(MAX_IMPORT_ROWS + 1)}`)).toBe("too_many_rows");
    expect(fail("x".repeat(1_000_001))).toBe("file_too_large");
  });
  it("열 순서가 달라도, 선택 열이 없어도 읽는다", () => {
    const v = parse("1000,A\r\n", "판매가,상품명");
    expect(v.products[0].input).toMatchObject({ name: "A", price: 1000, status: "DRAFT" });
  });
});
