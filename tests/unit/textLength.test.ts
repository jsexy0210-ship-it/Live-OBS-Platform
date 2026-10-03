import { describe, expect, it } from "vitest";
import { PRODUCT_NAME_MAX } from "../../lib/server/products/manage";
import { cleanText, textLength } from "../../lib/server/text/clean";

// MASTER 확인 요청(2026-10-03): 상품명 글자 수는 UTF-16 길이가 아니라 코드포인트로 센다.
describe("글자 수(코드포인트)", () => {
  const thumbs = "\u{1f44d}";
  it("이모지 하나를 1자로 센다(UTF-16으로는 2)", () => {
    expect(thumbs.length).toBe(2);
    expect(textLength(thumbs)).toBe(1);
    expect(textLength(thumbs.repeat(51))).toBe(51);
    expect(textLength("  가나다  ")).toBe(3);
  });

  it("👍 51개(UTF-16 102)는 100자 상품명으로 받고, 101자는 거부한다", () => {
    expect(cleanText(thumbs.repeat(51), PRODUCT_NAME_MAX)).toBe(thumbs.repeat(51));
    expect(cleanText(thumbs.repeat(100), PRODUCT_NAME_MAX)).toBe(thumbs.repeat(100));
    expect(cleanText(thumbs.repeat(101), PRODUCT_NAME_MAX)).toBeNull();
    expect(cleanText("가".repeat(100), PRODUCT_NAME_MAX)).not.toBeNull();
    expect(cleanText("가".repeat(101), PRODUCT_NAME_MAX)).toBeNull();
  });
});
