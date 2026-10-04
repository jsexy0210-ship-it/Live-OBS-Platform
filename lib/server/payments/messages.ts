import type { BankTransferRejection } from "./bank";
import type { ShippingPreviewRejection } from "./shippingPreview";
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

// 무통장 입금 선택(구매자, 해요체)
export const BANK_TRANSFER_MESSAGES: Record<BankTransferRejection, string> = {
  shop_unavailable: PAYMENT_MESSAGES.shop_unavailable,
  not_found: PAYMENT_MESSAGES.not_found,
  order_not_payable: PAYMENT_MESSAGES.order_not_payable,
  already_paid: PAYMENT_MESSAGES.already_paid,
  amount_mismatch: PAYMENT_MESSAGES.amount_mismatch,
  bank_account_missing: "지금은 무통장 입금을 받을 수 없어요. 판매자에게 문의해 주세요",
};

export const bankTransferStatus = (reason: BankTransferRejection) =>
  reason === "shop_unavailable" ? 402 : reason === "not_found" ? 404 : 409;

// 파트너스 관리자 결제 API(합니다체)
export const SELLER_PAYMENT_MESSAGES = {
  invalid_bank_account: "은행 이름·계좌번호·예금주를 확인해 주십시오. 계좌번호는 숫자와 하이픈만 쓸 수 있습니다",
  invalid_request: "요청 값을 확인해 주십시오",
  conflict: "다른 곳에서 바뀐 내용이 있습니다. 새로 고친 뒤 다시 시도해 주십시오",
} as const;

export const sellerPaymentErrorBody = (reason: keyof typeof SELLER_PAYMENT_MESSAGES) => ({ error: reason, message: SELLER_PAYMENT_MESSAGES[reason] });

// 배송비 미리보기(구매자, 해요체)
export const SHIPPING_PREVIEW_MESSAGES: Record<ShippingPreviewRejection, string> = {
  shop_unavailable: PAYMENT_MESSAGES.shop_unavailable,
  invalid_items: "상품을 다시 골라 주세요",
  invalid_address: "우편번호와 주소를 확인해 주세요",
  product_unavailable: "지금 살 수 없는 상품이 있어요",
};
