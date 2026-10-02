// 주문·배송·상품 거부 사유별 화면 문구(해요체). 화면은 error 코드로 분기하고 message를 그대로 보여 준다.
// 문구는 여기 한 곳에서만 고친다.
export const ORDER_ERROR_MESSAGES = {
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  consent_required: "안내를 확인하고 동의해 주세요",
  consent_outdated: "안내가 바뀌었어요. 다시 확인하고 동의해 주세요",
  invalid_items: "담은 상품을 다시 확인해 주세요",
  product_unavailable: "지금은 살 수 없는 상품이 있어요",
  out_of_stock: "재고가 부족해요",
  reward_use_not_supported: "적립금은 아직 쓸 수 없어요",
  invalid_amount: "주문 금액을 계산할 수 없어요. 판매자에게 문의해 주세요",
  invalid_shipping_address: "받는 분, 연락처, 주소를 다시 확인해 주세요",
  invalid_shipment: "택배사와 송장번호를 다시 확인해 주세요",
  not_shippable: "결제가 끝난 주문만 발송할 수 있어요",
  invalid_shipping_policy: "배송비 설정을 다시 확인해 주세요",
  // 판매자 상품·옵션
  invalid_product: "상품 정보를 다시 확인해 주세요",
  invalid_option: "옵션 정보를 다시 확인해 주세요",
  invalid_price: "가격은 1원 이상, 21억 원 이하로 입력해 주세요. 옵션 추가금을 더한 가격도 같아요",
  too_many_options: "옵션은 상품 하나에 100개까지 만들 수 있어요",
  no_sellable_option: "판매하려면 옵션이 하나 이상 있어야 해요",
  stock_conflict: "그사이 재고가 바뀌었어요. 새로 불러온 뒤 다시 입력해 주세요",
  invalid_cursor: "목록을 처음부터 다시 불러와 주세요",
  invalid_limit: "한 번에 볼 개수는 1~200개로 정해 주세요",
} as const;

export type OrderErrorCode = keyof typeof ORDER_ERROR_MESSAGES;

export const orderErrorBody = (code: OrderErrorCode) => ({ error: code, message: ORDER_ERROR_MESSAGES[code] });
