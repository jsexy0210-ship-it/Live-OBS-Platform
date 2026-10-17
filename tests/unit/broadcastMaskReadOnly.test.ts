import { describe, expect, it } from "vitest";
import { maskBroadcastDetail, maskBroadcastHistory, maskBroadcastSummary } from "../../lib/server/broadcast/maskReadOnly";

describe("대신 보기 방송 금액 가림", () => {
  it("요약·이력·상세의 매출·주문 금액·단가·환불액만 null이 되고 건수는 그대로다", () => {
    expect(maskBroadcastSummary({ broadcast: null, summary: { orders: 3, sales: 9000 } })).toEqual({ broadcast: null, summary: { orders: 3, sales: null } });
    expect(maskBroadcastSummary({ broadcast: null, summary: null })).toEqual({ broadcast: null, summary: null });
    expect(maskBroadcastHistory({ monthSummary: { orders: 2, avgSales: 500 }, items: [{ id: "a", summary: { orders: 1, sales: 700 } }], nextCursor: null })).toEqual({
      monthSummary: { orders: 2, avgSales: null },
      items: [{ id: "a", summary: { orders: 1, sales: null } }],
      nextCursor: null,
    });
    expect(maskBroadcastDetail({ summary: { sales: 1, orders: 1 }, orders: [{ orderNo: 1, totalAmount: 5, refundAmount: 2, items: [{ quantity: 1, unitPrice: 5 }] }] })).toEqual({
      summary: { sales: null, orders: 1 },
      orders: [{ orderNo: 1, totalAmount: null, refundAmount: null, items: [{ quantity: 1, unitPrice: null }] }],
    });
  });
});
