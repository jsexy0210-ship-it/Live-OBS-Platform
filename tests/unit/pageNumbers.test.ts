import { describe, expect, it } from "vitest";
import { pageNumbers } from "../../components/Pagination";

// Shared total/offset contract: 10-number groups containing the normalized page.
describe("pageNumbers", () => {
  it("7쪽 이하는 모두", () => {
    expect(pageNumbers(1, 2)).toEqual([1, 2]);
    expect(pageNumbers(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("10개 묶음과 마지막 묶음을 표시한다", () => {
    expect(pageNumbers(10, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pageNumbers(11, 13)).toEqual([11, 12, 13]);
  });
  it("비어 있거나 잘못된 페이지도 실제 범위를 지킨다", () => {
    expect(pageNumbers(1, 0)).toEqual([]);
    expect(pageNumbers(-1, 1)).toEqual([1]);
    expect(pageNumbers(NaN, 2)).toEqual([1, 2]);
    expect(pageNumbers(100, 13)).toEqual([11, 12, 13]);
  });
});
