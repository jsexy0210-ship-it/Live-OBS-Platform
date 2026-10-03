import { describe, expect, it } from "vitest";
import { ORDER_ERROR_MESSAGES, purchaseRestrictedMessage } from "../../lib/server/orders/messages";

describe("구매 제한 안내 문구(KST)", () => {
  it("풀리는 시각을 한국 시간 날짜·시각으로 알려 주고, 정각이면 분은 뺀다", () => {
    expect(purchaseRestrictedMessage(new Date("2026-11-02T06:05:00Z"))).toBe("11월 2일 오후 3시 5분부터 다시 주문할 수 있어요");
    expect(purchaseRestrictedMessage(new Date("2026-11-02T01:00:00Z"))).toBe("11월 2일 오전 10시부터 다시 주문할 수 있어요");
    // UTC로는 전날이어도 KST 날짜로 보여 준다
    expect(purchaseRestrictedMessage(new Date("2026-11-02T15:30:00Z"))).toBe("11월 3일 오전 12시 30분부터 다시 주문할 수 있어요");
    expect(purchaseRestrictedMessage(new Date("2026-12-31T03:00:00Z"))).toBe("12월 31일 오후 12시부터 다시 주문할 수 있어요");
  });
});

describe("화면 용어(파트너스 관리자는 「파트너스」, 구매자 화면은 「판매자」)", () => {
  it("파트너스 관리자 환불 안내는 「파트너스 사정」(화면 선택지 이름과 같게), 구매자 안내는 「판매자에게 문의」 그대로", () => {
    expect(ORDER_ERROR_MESSAGES.fault_required).toBe("구매자 사정인지 파트너스 사정인지 골라 주세요");
    expect(ORDER_ERROR_MESSAGES.invalid_amount).toContain("판매자에게 문의해 주세요");
    expect(ORDER_ERROR_MESSAGES.purchase_restricted).toContain("판매자에게 문의해 주세요");
  });
});
