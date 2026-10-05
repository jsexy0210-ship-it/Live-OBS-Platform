import type { RefundFault } from "@prisma/client";
import { REWARD_USE_UNIT } from "./rewardUse";

// 부분 환불 계산(MASTER 배정 2026-10-05, SA-023). queue/service.ts computeRefund(한 번에 전부 환불)와 같은 규칙을 품목·수량 단위로 나눠 적용한다.
// 누적 값으로 계산하므로(이번 몫 = 이번까지 누적 목표 − 지난번까지 누적) 여러 번 나눠도 끝전이 쌓이지 않고, 마지막 환불이 남은 금액을 모두 맞춘다.
// - 품목 금액: 단가 × 수량 − 그 품목 쿠폰 배분액. 수량 일부면 배분액을 수량 비율로 나눠 내림(n개 누적 금액 = 단가 × n − ⌊배분액 × n ÷ 수량⌋).
//   구매자 사정이면 개봉한 품목은 0원(OPENED_NO_REFUND 동의).
// - 배송비: 마지막 환불(모든 품목을 환불하는 환불)에서만, 발송 전이거나 판매자 사정이면 돌려준다.
// - 반품 배송비: 발송 후 구매자 사정이고 돌려줄 상품이 있는 환불마다(처음 배송비 0원이면 × 2). 현금 환불액에서 0원 아래로 내려가지 않게 뺀다.
// - 쓴 적립금: 누적 돌아오는 상품 금액 ÷ 주문 상품 금액 비율로 10원 단위 내림. 누적이 주문 상품 금액 전부면 남은 전액. 그만큼 현금에서 뺀다.
// - 현금 환불액은 결제 금액 − 이미 돌려준 현금을 넘지 않는다.
export type RefundCalcItem = {
  id: string;
  unitPrice: number;
  quantity: number;
  couponDiscount: number;
  opened: boolean;
  refundedQuantity: number;
  // 이번에 환불할 수량(0이면 이번 환불에 없음)
  select: number;
};
export type RefundCalcHistory = { itemsAmount: number; cash: number; rewardReturn: number };
export type RefundStep = {
  lines: { orderItemId: string; quantity: number; amount: number }[];
  itemsAmount: number;
  shippingRefunded: number;
  refundAmount: number;
  returnFeeDeducted: number;
  rewardReturn: number;
  isFinal: boolean;
};

// n개 누적 품목 금액(쿠폰 배분 뺀 값)
export function itemValue(i: { unitPrice: number; quantity: number; couponDiscount: number }, n: number): number {
  if (n <= 0) return 0;
  return i.unitPrice * n - Math.floor((i.couponDiscount * n) / i.quantity);
}

export function computeRefundStep(input: {
  items: RefundCalcItem[];
  shippingFee: number;
  totalAmount: number;
  shipped: boolean;
  fault: RefundFault | null;
  returnFee: number;
  rewardUsed: number;
  history: RefundCalcHistory;
}): RefundStep {
  const buyerFault = input.fault === "BUYER";
  const lines = input.items
    .filter((i) => i.select > 0)
    .map((i) => ({
      orderItemId: i.id,
      quantity: i.select,
      amount: buyerFault && i.opened ? 0 : itemValue(i, i.refundedQuantity + i.select) - itemValue(i, i.refundedQuantity),
    }));
  const itemsAmount = lines.reduce((a, l) => a + l.amount, 0);
  const ordered = input.items.reduce((a, i) => a + itemValue(i, i.quantity), 0);
  const isFinal = input.items.every((i) => i.refundedQuantity + i.select >= i.quantity);

  const returnedCum = input.history.itemsAmount + itemsAmount;
  let rewardTarget = 0;
  if (input.rewardUsed > 0) {
    if (returnedCum >= ordered) rewardTarget = input.rewardUsed;
    else if (ordered > 0 && returnedCum > 0) {
      const raw = Math.floor((input.rewardUsed * returnedCum) / ordered);
      rewardTarget = raw - (raw % REWARD_USE_UNIT);
    }
  }
  const rewardReturn = Math.max(0, Math.min(rewardTarget, input.rewardUsed) - input.history.rewardReturn);

  const shippingRefunded = isFinal && (!input.shipped || input.fault === "SELLER") ? input.shippingFee : 0;
  const fee = input.shipped && buyerFault && itemsAmount > 0 ? input.returnFee * (input.shippingFee === 0 ? 2 : 1) : 0;
  const cashLeft = Math.max(0, input.totalAmount - input.history.cash);
  const gross = Math.max(0, Math.min(itemsAmount + shippingRefunded - rewardReturn, cashLeft));
  const returnFeeDeducted = Math.min(fee, gross);
  return { lines, itemsAmount, shippingRefunded, refundAmount: gross - returnFeeDeducted, returnFeeDeducted, rewardReturn, isFinal };
}

// 주문 적립 회수액(이번 몫). 마지막 환불이면 남은 전부, 아니면 누적 환불 수량의 적립 기준액(단가 × 수량, 쿠폰·적립금 무관, queue/service.ts rewardBase) 비율로 내림.
export function earnRevokeStep(o: { earnTotal: number; items: Pick<RefundCalcItem, "unitPrice" | "quantity" | "refundedQuantity" | "select">[]; isFinal: boolean; revokedBefore: number }): number {
  if (o.earnTotal <= 0) return 0;
  const base = o.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0);
  const cum = o.items.reduce((a, i) => a + i.unitPrice * Math.min(i.quantity, i.refundedQuantity + i.select), 0);
  const target = o.isFinal || base <= 0 ? o.earnTotal : Math.floor((o.earnTotal * cum) / base);
  return Math.max(0, target - o.revokedBefore);
}
