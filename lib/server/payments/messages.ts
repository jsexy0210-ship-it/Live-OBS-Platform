import type { StartRejection } from "./service";

// 구매자 결제 API 화면 문구(해요체, 구매자 쇼핑몰 화면에 그대로 보여 준다).
export const PAYMENT_MESSAGES: Record<StartRejection | "payment_not_ready" | "invalid_request", string> = {
  payment_not_ready: "결제 준비 중이에요. 잠시 후 다시 시도해 주세요",
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  not_found: "주문을 찾을 수 없어요",
  order_not_payable: "결제할 수 없는 주문이에요. 주문 상태를 확인해 주세요",
  already_paid: "이미 결제했거나 결제가 진행 중인 주문이에요",
  amount_mismatch: "주문 금액이 바뀌었어요. 주문을 다시 해 주세요",
  invalid_request: "요청을 다시 확인해 주세요",
};

export const paymentErrorBody = (reason: keyof typeof PAYMENT_MESSAGES) => ({ error: reason, message: PAYMENT_MESSAGES[reason] });

export const startPaymentStatus = (reason: StartRejection) =>
  reason === "shop_unavailable" ? 402 : reason === "not_found" ? 404 : 409;
