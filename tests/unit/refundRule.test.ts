import { describe, expect, it } from "vitest";
import { computeRefund } from "../../lib/server/queue/service";

// 환불 판정(PRODUCT_SCOPE 「판매 방식과 환불 고지」·「반품·교환 배송비」, 대표님 확정 2026-10-03):
// 「개봉하면 단순 변심으로는 취소·환불이 안 돼요. 상품이 설명과 다르거나 잘못 왔으면 환불받을 수 있어요」
// - 구매자 사정(단순 변심): 개봉한 상품은 돌려주지 않고, 발송 뒤면 처음 배송비는 돌려주지 않고 반품 배송비를 뺀다.
// - 판매자 사정(설명과 다름·불량·오배송): 개봉했어도 상품 금액과 처음 배송비를 모두 돌려주고 반품 배송비를 받지 않는다.
const items = [
  { unitPrice: 10000, quantity: 1, opened: true },
  { unitPrice: 5000, quantity: 2, opened: false },
];
const base = { items, shippingFee: 3000, totalAmount: 23000, shipped: true, returnFee: 2500 };

describe("환불 판정: 발송 뒤 개봉 상품이 섞인 주문", () => {
  it("판매자 사정(설명과 다름·오배송)이면 개봉한 상품까지 전부와 처음 배송비를 돌려주고 반품 배송비를 받지 않는다", () => {
    expect(computeRefund({ ...base, fault: "SELLER" })).toEqual({ refundAmount: 23000, returnFeeDeducted: 0, rewardReturn: 0 });
  });

  it("구매자 사정(단순 변심)이면 개봉한 상품은 빼고, 처음 배송비는 돌려주지 않으며 반품 배송비(편도)를 뺀다", () => {
    expect(computeRefund({ ...base, fault: "BUYER" })).toEqual({ refundAmount: 10000 - 2500, returnFeeDeducted: 2500, rewardReturn: 0 });
  });

  it("구매자 사정인데 모두 개봉했으면 돌려줄 상품이 없어 0원이고 반품 배송비도 빼지 않는다", () => {
    const allOpened = items.map((i) => ({ ...i, opened: true }));
    expect(computeRefund({ ...base, items: allOpened, fault: "BUYER" })).toEqual({ refundAmount: 0, returnFeeDeducted: 0, rewardReturn: 0 });
    // 같은 주문도 판매자 사정이면 전액
    expect(computeRefund({ ...base, items: allOpened, fault: "SELLER" })).toEqual({ refundAmount: 23000, returnFeeDeducted: 0, rewardReturn: 0 });
  });

  it("판매자 사정 환불액은 결제 금액(적립금 사용 뒤)을 넘지 않는다", () => {
    expect(computeRefund({ ...base, totalAmount: 20000, fault: "SELLER" })).toEqual({ refundAmount: 20000, returnFeeDeducted: 0, rewardReturn: 0 });
  });
});
