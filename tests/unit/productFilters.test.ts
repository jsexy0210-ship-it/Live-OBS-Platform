import { describe, expect, it } from "vitest";
import { filterCount, filterParams, parseFilters, priceLabel } from "../../app/(shop)/shop/[slug]/_lib/filters";
import { sortKey } from "../../app/(shop)/shop/[slug]/_lib/catalog";

// SH-002 필터 주소 해석: 주소 값을 그대로 믿지 않고 걸러 서버가 400·404를 내지 않게 한다
const tree = [
  { id: "g1", name: "게임", children: [{ id: "a", name: "포켓몬" }, { id: "b", name: "원피스" }] },
  { id: "g2", name: "형태", children: [{ id: "c", name: "부스터 박스" }] },
];

describe("parseFilters", () => {
  it("있는 하위 분류·플래그·가격만 받는다", () => {
    const f = parseFilters({ cats: "a,c,없는분류,a", inStock: "1", live: "1", rating4: "1", minPrice: "1000", maxPrice: "5000" }, tree);
    expect(f).toEqual({ cats: ["a", "c"], inStock: true, live: true, rating4: true, min: "1000", max: "5000" });
    expect(filterCount(f)).toBe(6);
  });
  it("이상한 값은 버린다", () => {
    const f = parseFilters({ cats: "x", inStock: "2", rating4: "invalid", minPrice: "abc", maxPrice: "-5" }, tree);
    expect(f).toEqual({ cats: [], inStock: false, live: false, rating4: false, min: "", max: "" });
    expect(filterCount(f)).toBe(0);
  });
  it("최대가 최소보다 작으면 가격 조건을 버린다", () => {
    expect(parseFilters({ minPrice: "5000", maxPrice: "1000" }, tree)).toMatchObject({ min: "", max: "" });
  });
  it("주소·가격 표기", () => {
    const f = parseFilters({ cats: "a", inStock: "1", rating4: "1", minPrice: "100000" }, tree);
    expect(filterParams(f).toString()).toBe("cats=a&inStock=1&rating4=1&minPrice=100000");
    expect(priceLabel(f)).toBe("100,000원 이상");
    expect(priceLabel({ ...f, min: "1000", max: "5000" })).toBe("1,000원 ~ 5,000원");
    expect(priceLabel({ ...f, min: "", max: "5000" })).toBe("5,000원 이하");
  });
});

describe("sortKey", () => {
  it("관련도순은 검색어가 있을 때만, 검색의 기본이다", () => {
    expect(sortKey(undefined, true)).toBe("relevance");
    expect(sortKey("relevance", true)).toBe("relevance");
    expect(sortKey("relevance", false)).toBe("new");
    expect(sortKey("low", true)).toBe("low");
    expect(sortKey(undefined, false)).toBe("new");
  });
});
