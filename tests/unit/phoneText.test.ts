import { describe, expect, it } from "vitest";
import { phoneText } from "../../components/seller/orders";

// 판매자 주문 상세의 연락처 표시(하이픈). 서울 02 번호는 지역번호가 두 자리라 따로 묶는다.
describe("phoneText", () => {
  it("서울 02 번호: 9자리는 02-XXX-XXXX, 10자리는 02-XXXX-XXXX", () => {
    expect(phoneText("021234567")).toBe("02-123-4567");
    expect(phoneText("0212345678")).toBe("02-1234-5678");
  });
  it("그 밖의 지역번호·휴대폰은 앞 세 자리로 묶는다", () => {
    expect(phoneText("0311234567")).toBe("031-123-4567");
    expect(phoneText("03112345678")).toBe("031-1234-5678");
    expect(phoneText("01012345678")).toBe("010-1234-5678");
  });
  it("하이픈이 이미 있어도 숫자만 보고 다시 묶고, 모르는 형식은 그대로 둔다", () => {
    expect(phoneText("010-1234-5678")).toBe("010-1234-5678");
    expect(phoneText("1588-1234")).toBe("1588-1234");
  });
});
