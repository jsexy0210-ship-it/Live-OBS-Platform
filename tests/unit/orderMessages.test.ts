import { describe, expect, it } from "vitest";
import { purchaseRestrictedMessage } from "../../lib/server/orders/messages";

describe("구매 제한 안내 문구(KST)", () => {
  it("풀리는 시각을 한국 시간 날짜·시각으로 알려 주고, 정각이면 분은 뺀다", () => {
    expect(purchaseRestrictedMessage(new Date("2026-11-02T06:05:00Z"))).toBe("11월 2일 오후 3시 5분부터 다시 주문할 수 있어요");
    expect(purchaseRestrictedMessage(new Date("2026-11-02T01:00:00Z"))).toBe("11월 2일 오전 10시부터 다시 주문할 수 있어요");
    // UTC로는 전날이어도 KST 날짜로 보여 준다
    expect(purchaseRestrictedMessage(new Date("2026-11-02T15:30:00Z"))).toBe("11월 3일 오전 12시 30분부터 다시 주문할 수 있어요");
    expect(purchaseRestrictedMessage(new Date("2026-12-31T03:00:00Z"))).toBe("12월 31일 오후 12시부터 다시 주문할 수 있어요");
  });
});
