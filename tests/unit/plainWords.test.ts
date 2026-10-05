import { describe, expect, it } from "vitest";
import { BUYER_LOGIN_ERROR_MESSAGES, LOGIN_ERROR_MESSAGES } from "../../lib/server/auth/messages";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { PAYMENT_MESSAGES } from "../../lib/server/payments/messages";
import { BUYER_RETURN_MESSAGES } from "../../lib/server/shop-returns/service";

// 쉬운 말 감사(docs/UX_PLAIN_AUDIT.md 「개발 전담 (기반)」 11건): 서버가 내려 주는 문구가 어려운 말·코드값·뜻 둘 없이 무엇을 하면 되는지 알려 주는지 고정한다.
describe("서버 응답 문구 쉬운 말", () => {
  it("파트너스 로그인: 휴면·승인 같은 어려운 말 대신 쉬운 말과 본인 확인 위치를 알려 준다", () => {
    expect(LOGIN_ERROR_MESSAGES.dormant).toBe("오래 쓰지 않아 쉬고 있는 계정입니다. 「아이디/비밀번호 찾기」에서 본인 확인을 하면 다시 쓸 수 있습니다");
    expect(LOGIN_ERROR_MESSAGES.seller_pending).toBe("가입 신청을 확인하고 있습니다. 확인이 끝나면 알려 드립니다");
    expect(`${LOGIN_ERROR_MESSAGES.dormant}${LOGIN_ERROR_MESSAGES.seller_pending}`).not.toMatch(/휴면|승인/);
  });
  it("구매자 로그인: 탭 없는 화면에 탭 말을 쓰지 않고, 무엇을 하면 되는지 알려 준다", () => {
    expect(BUYER_LOGIN_ERROR_MESSAGES.wrong_account_type).toBe("이 계정으로는 이 쇼핑몰에 로그인할 수 없어요. 가입한 쇼핑몰 주소에서 다시 로그인해 주세요");
    expect(BUYER_LOGIN_ERROR_MESSAGES.wrong_account_type).not.toMatch(/탭/);
    expect(BUYER_LOGIN_ERROR_MESSAGES.dormant).toBe("오래 쓰지 않아 쉬고 있는 계정이에요. 쇼핑몰에 문의하면 다시 쓸 수 있어요");
    expect(BUYER_LOGIN_ERROR_MESSAGES.seller_pending).toBe("쇼핑몰이 아직 문을 열 준비를 하고 있어요. 열리면 로그인해 주세요");
  });
  it("주문·결제·반품·쿠폰: 해결 방법이 있고 뜻이 하나다", () => {
    expect(ORDER_ERROR_MESSAGES.consent_required).toBe("주문서 아래 안내를 읽고 체크 칸에 동의해 주세요");
    expect(ORDER_ERROR_MESSAGES.out_of_stock).toBe("남은 수량이 모자라요. 수량을 줄이거나 장바구니를 확인해 주세요");
    expect(PAYMENT_MESSAGES.already_paid).toBe("이미 결제한 주문이에요. 주문 내역에서 확인해 주세요");
    expect(PAYMENT_MESSAGES.invalid_request).toBe("입력한 내용이 맞지 않아요. 화면을 새로 열고 다시 해 주세요");
    expect(BUYER_RETURN_MESSAGES.invalid_items).toBe("신청할 상품을 골라 주세요");
    expect(BUYER_RETURN_MESSAGES.wrong_image_size).toBe("사진 가로·세로가 맞지 않아요. 가로·세로 100~4,000px 사진으로 올려 주세요");
  });
});
