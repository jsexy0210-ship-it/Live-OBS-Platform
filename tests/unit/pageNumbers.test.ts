import { describe, expect, it } from "vitest";
import { pageNumbers } from "../../app/(shop)/shop/[slug]/_lib/ProductListing";

// SH-002 숫자 페이저: 7쪽까지는 모두, 그보다 많으면 지금 쪽 둘레 5개
describe("pageNumbers", () => {
  it("7쪽 이하는 모두", () => {
    expect(pageNumbers(1, 2)).toEqual([1, 2]);
    expect(pageNumbers(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("많으면 지금 쪽 둘레 5개, 처음·끝에서는 끝에 붙인다", () => {
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(pageNumbers(20, 20)).toEqual([16, 17, 18, 19, 20]);
  });
});
