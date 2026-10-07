import { describe, expect, it } from "vitest";
import { parseAmount } from "../../components/seller/format";

describe("상품 판매가 입력", () => {
  it.each(["12000", "12,000원", "１２，０００", "+12000"])("표시 형식 %s를 같은 정수로 읽는다", value => {
    expect(parseAmount(value)).toBe(12000);
  });
  it.each(["12.5", "1e3", "가격", "9007199254740992"])("정수가 아닌 입력 %s는 저장 값으로 읽지 않는다", value => {
    expect(parseAmount(value)).toBeNull();
  });
});
