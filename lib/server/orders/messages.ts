import type { MessageTone } from "../text/tone";

// 주문·배송·상품 거부 사유별 화면 문구. 화면은 error 코드로 분기하고 message를 그대로 보여 준다.
// 문구는 여기 한 곳에서만 고친다. 구매자 쇼핑몰 API는 해요체(아래 표), 파트너스 관리자 API는 합니다체(ORDER_ERROR_MESSAGES_FORMAL).
export const ORDER_ERROR_MESSAGES = {
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  consent_required: "안내를 확인하고 동의해 주세요",
  consent_outdated: "안내가 바뀌었어요. 다시 확인하고 동의해 주세요",
  invalid_items: "담은 상품을 다시 확인해 주세요",
  product_unavailable: "지금은 살 수 없는 상품이 있어요",
  out_of_stock: "재고가 부족해요",
  reward_use_not_supported: "적립금은 아직 쓸 수 없어요",
  invalid_reward_use: "적립금은 1,000원부터 10원 단위로 쓸 수 있어요",
  reward_use_unavailable: "이 쇼핑몰은 지금 적립금을 쓸 수 없어요",
  reward_use_over_limit: "적립금은 상품 금액까지만 쓸 수 있어요. 배송비에는 쓸 수 없어요",
  reward_balance_insufficient: "적립금이 부족해요",
  invalid_amount: "주문 금액을 계산할 수 없어요. 판매자에게 문의해 주세요",
  invalid_shipping_address: "받는 분, 연락처, 주소를 다시 확인해 주세요",
  invalid_order_nickname: "주문 닉네임은 20자까지, 글자와 숫자로 써 주세요",
  invalid_shipment: "택배사와 송장번호를 다시 확인해 주세요",
  not_shippable: "결제가 끝난 주문만 발송할 수 있어요",
  not_deliverable: "배송 중인 주문만 배송 완료로 바꿀 수 있어요",
  invalid_reward_policy: "적립금 지급 시점을 다시 골라 주세요",
  invalid_shipping_policy: "배송비 설정을 다시 확인해 주세요",
  // 구매자 저장 배송지
  invalid_address_label: "배송지 이름을 다시 확인해 주세요",
  address_label_too_long: "배송지 이름은 20자까지 쓸 수 있어요",
  too_many_addresses: "배송지는 20개까지 저장할 수 있어요. 안 쓰는 배송지를 지운 뒤 다시 해 주세요",
  duplicate_address: "이미 저장된 배송지예요",
  address_not_found: "배송지를 찾을 수 없어요",
  default_address_required: "다른 배송지를 기본으로 정해 주세요",
  // 판매자 상품·옵션
  invalid_product: "상품 정보를 다시 확인해 주세요",
  product_name_too_long: "상품명은 100자까지 쓸 수 있어요",
  invalid_option: "옵션 정보를 다시 확인해 주세요",
  invalid_price: "가격은 1원 이상, 21억 원 이하로 입력해 주세요. 옵션 추가금을 더한 가격도 같아요",
  // 이벤트 할인
  invalid_event: "할인율은 1~90%, 할인 금액은 1원 이상 가격의 90% 이하로 정해 주세요",
  invalid_event_period: "할인 기간을 다시 확인해 주세요. 끝나는 때는 지금보다 뒤, 시작부터 1년 안이어야 해요",
  event_price_too_low: "할인한 가격이 1원보다 낮아져요. 할인이나 가격을 다시 확인해 주세요",
  too_many_options: "옵션은 상품 하나에 100개까지 만들 수 있어요",
  no_sellable_option: "판매하려면 옵션이 하나 이상 있어야 해요",
  stock_conflict: "그사이 재고가 바뀌었어요. 새로 불러온 뒤 다시 입력해 주세요",
  invalid_cursor: "목록을 처음부터 다시 불러와 주세요",
  invalid_limit: "한 번에 볼 개수는 1~200개로 정해 주세요",
  invalid_stock_filter: "재고 조건을 다시 확인해 주세요",
  invalid_search: "검색어는 50자까지, 쓸 수 있는 글자로 입력해 주세요",
  invalid_sort: "정렬 기준을 다시 확인해 주세요",
  invalid_date_range: "기간을 다시 확인해 주세요. 시작일이 종료일보다 늦을 수 없어요",
  invalid_code: "상품 코드는 64자까지, 쓸 수 있는 글자로 입력해 주세요",
  invalid_stock_deduct_mode: "재고 차감 시점을 다시 확인해 주세요",
  invalid_display: "노출 상태를 다시 확인해 주세요",
  invalid_bulk: "처리할 상품(1~200개)과 작업을 다시 확인해 주세요",
  invalid_category: "카테고리를 다시 확인해 주세요. 이름은 30자까지, 2단까지 만들 수 있어요",
  too_many_categories: "카테고리는 300개까지 만들 수 있어요",
  category_has_children: "아래 카테고리를 먼저 지워 주세요",
  invalid_category_order: "카테고리 목록이 바뀌었어요. 새로 불러온 뒤 다시 정해 주세요",
  too_many_product_categories: "상품 하나에 카테고리는 10개까지 지정할 수 있어요",
  invalid_detail: "상세 페이지를 다시 확인해 주세요. 글은 2000자까지, 블록은 30개까지예요",
  invalid_query: "검색 조건을 다시 확인해 주세요",
  invalid_display_settings: "진열 설정을 다시 확인해 주세요",
  // 무통장 입금·구매 제한
  purchase_restricted: "입금하지 않은 주문이 쌓여서 지금은 주문할 수 없어요. 판매자에게 문의해 주세요",
  order_rate_limited: "잠시 뒤 다시 주문해 주세요",
  invalid_order_policy: "자동 취소 기간은 1시간에서 30일, 자동 배송 완료·구매 확정은 1일에서 30일 사이로 정해 주세요",
  no_restriction: "주문 제한이 걸려 있지 않아요",
  already_restricted: "이미 주문이 제한된 회원이에요",
  invalid_restriction: "제한 기간(1~365일)과 사유(200자 이내)를 확인해 주세요",
  invalid_memo: "메모는 1,000자 이내로 적어 주세요",
  invalid_reason: "사유를 다시 확인해 주세요",
  // 수동 재고 증감
  invalid_stock_adjust: "바꿀 수량(0이 아닌 정수)과 사유(100자 이내)를 확인해 주세요",
  insufficient_stock: "재고가 모자라서 뺄 수 없어요",
  stock_too_large: "재고는 21억 개까지 넣을 수 있어요",
  // 환불
  fault_required: "구매자 사정인지 파트너스 사정인지 골라 주세요",
  opened_items_present: "개봉한 상품이 있어요. 확인한 뒤 다시 환불해 주세요",
  opened_items_unshipped: "보내기 전 개봉한 상품은 구매자 사정으로 환불할 수 없어요. 개봉하지 않은 상품만 골라 주세요",
  invalid_refund_items: "환불할 상품과 수량을 다시 골라 주세요",
  queued_item_partial: "개봉을 기다리거나 개봉 중인 상품은 수량 전부를 환불해야 해요",
  purchase_confirmed: "구매 확정한 주문이에요. 구매 확정을 먼저 취소해 주세요",
  // 구매 확정 취소
  not_confirmed: "구매 확정한 주문만 확정을 취소할 수 있어요",
  not_unconfirmed: "구매 확정을 취소한 주문만 다시 확정할 수 있어요",
} as const;

// 구매자 주문 화면 안내 문구(해요체)
export const ORDER_NOTICES = {
  stock_shortage_refund: "재고가 부족해 주문을 취소하고 환불해 드릴 예정이에요",
} as const;

export type OrderErrorCode = keyof typeof ORDER_ERROR_MESSAGES;

// 파트너스 관리자 API(app/api/seller/**) 문구(합니다체, lib/server/text/tone.ts)
export const ORDER_ERROR_MESSAGES_FORMAL: Record<OrderErrorCode, string> = {
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없습니다",
  consent_required: "안내를 확인하고 동의해 주십시오",
  consent_outdated: "안내가 바뀌었습니다. 다시 확인하고 동의해 주십시오",
  invalid_items: "담은 상품을 다시 확인해 주십시오",
  product_unavailable: "지금은 살 수 없는 상품이 있습니다",
  out_of_stock: "재고가 부족합니다",
  reward_use_not_supported: "적립금은 아직 쓸 수 없습니다",
  invalid_reward_use: "적립금은 1,000원부터 10원 단위로 쓸 수 있습니다",
  reward_use_unavailable: "이 쇼핑몰은 지금 적립금을 쓸 수 없습니다",
  reward_use_over_limit: "적립금은 상품 금액까지만 쓸 수 있습니다. 배송비에는 쓸 수 없습니다",
  reward_balance_insufficient: "적립금이 부족합니다",
  invalid_amount: "주문 금액을 계산할 수 없습니다. 상품 가격과 배송비 설정을 확인해 주십시오",
  invalid_shipping_address: "받는 분, 연락처, 주소를 다시 확인해 주십시오",
  invalid_order_nickname: "주문 닉네임은 20자까지, 글자와 숫자로 써 주십시오",
  invalid_shipment: "택배사와 송장번호를 다시 확인해 주십시오",
  not_shippable: "결제가 끝난 주문만 발송할 수 있습니다",
  not_deliverable: "배송 중인 주문만 배송 완료로 바꿀 수 있습니다",
  invalid_reward_policy: "적립금 지급 시점을 다시 골라 주십시오",
  invalid_shipping_policy: "배송비 설정을 다시 확인해 주십시오",
  invalid_address_label: "배송지 이름을 다시 확인해 주십시오",
  address_label_too_long: "배송지 이름은 20자까지 쓸 수 있습니다",
  too_many_addresses: "배송지는 20개까지 저장할 수 있습니다. 안 쓰는 배송지를 지운 뒤 다시 해 주십시오",
  duplicate_address: "이미 저장된 배송지입니다",
  address_not_found: "배송지를 찾을 수 없습니다",
  default_address_required: "다른 배송지를 기본으로 정해 주십시오",
  invalid_product: "상품 정보를 다시 확인해 주십시오",
  product_name_too_long: "상품명은 100자까지 쓸 수 있습니다",
  invalid_option: "옵션 정보를 다시 확인해 주십시오",
  invalid_price: "가격은 1원 이상, 21억 원 이하로 입력해 주십시오. 옵션 추가금을 더한 가격도 같습니다",
  invalid_event: "할인율은 1~90%, 할인 금액은 1원 이상 가격의 90% 이하로 정해 주십시오",
  invalid_event_period: "할인 기간을 다시 확인해 주십시오. 끝나는 때는 지금보다 뒤, 시작부터 1년 안이어야 합니다",
  event_price_too_low: "할인한 가격이 1원보다 낮아집니다. 할인이나 가격을 다시 확인해 주십시오",
  too_many_options: "옵션은 상품 하나에 100개까지 만들 수 있습니다",
  no_sellable_option: "판매하려면 옵션이 하나 이상 있어야 합니다",
  stock_conflict: "그사이 재고가 바뀌었습니다. 새로 불러온 뒤 다시 입력해 주십시오",
  invalid_cursor: "목록을 처음부터 다시 불러와 주십시오",
  invalid_limit: "한 번에 볼 개수는 1~200개로 정해 주십시오",
  invalid_stock_filter: "재고 조건을 다시 확인해 주십시오",
  invalid_search: "검색어는 50자까지, 쓸 수 있는 글자로 입력해 주십시오",
  invalid_sort: "정렬 기준을 다시 확인해 주십시오",
  invalid_date_range: "기간을 다시 확인해 주십시오. 시작일이 종료일보다 늦을 수 없습니다",
  invalid_code: "상품 코드는 64자까지, 쓸 수 있는 글자로 입력해 주십시오",
  invalid_stock_deduct_mode: "재고 차감 시점을 다시 확인해 주십시오",
  invalid_display: "노출 상태를 다시 확인해 주십시오",
  invalid_bulk: "처리할 상품(1~200개)과 작업을 다시 확인해 주십시오",
  invalid_category: "카테고리를 다시 확인해 주십시오. 이름은 30자까지, 2단까지 만들 수 있습니다",
  too_many_categories: "카테고리는 300개까지 만들 수 있습니다",
  category_has_children: "하위 카테고리를 먼저 삭제해 주십시오",
  invalid_category_order: "카테고리 목록이 바뀌었습니다. 새로 불러온 뒤 다시 정해 주십시오",
  too_many_product_categories: "상품 하나에 카테고리는 10개까지 지정할 수 있습니다",
  invalid_detail: "상세 페이지를 다시 확인해 주십시오. 글은 2000자까지, 블록은 30개까지입니다",
  invalid_query: "검색 조건을 다시 확인해 주십시오",
  invalid_display_settings: "진열 설정을 다시 확인해 주십시오. 영역은 10개, 추천 상품은 20개까지입니다",
  purchase_restricted: "입금하지 않은 주문이 쌓여 지금은 주문할 수 없습니다",
  order_rate_limited: "잠시 뒤 다시 주문해 주십시오",
  invalid_order_policy: "자동 취소 기간은 1시간에서 30일, 자동 배송 완료·구매 확정은 1일에서 30일 사이로 정해 주십시오",
  no_restriction: "주문 제한이 걸려 있지 않습니다",
  already_restricted: "이미 주문이 제한된 회원입니다",
  invalid_restriction: "제한 기간(1~365일)과 사유(200자 이내)를 확인해 주십시오",
  invalid_memo: "메모는 1,000자 이내로 적어 주십시오",
  invalid_reason: "사유를 다시 확인해 주십시오",
  invalid_stock_adjust: "바꿀 수량(0이 아닌 정수)과 사유(100자 이내)를 확인해 주십시오",
  insufficient_stock: "재고가 모자라 뺄 수 없습니다",
  stock_too_large: "재고는 21억 개까지 넣을 수 있습니다",
  fault_required: "구매자 사정인지 파트너스 사정인지 골라 주십시오",
  opened_items_present: "개봉한 상품이 있습니다. 확인한 뒤 다시 환불해 주십시오",
  opened_items_unshipped: "보내기 전 개봉한 상품은 구매자 사정으로 환불할 수 없습니다. 개봉하지 않은 상품만 골라 주십시오",
  invalid_refund_items: "환불할 상품과 수량을 다시 골라 주십시오",
  queued_item_partial: "개봉 대기·개봉 중인 상품은 수량 전부를 환불해야 합니다",
  purchase_confirmed: "구매 확정한 주문입니다. 구매 확정을 먼저 취소해 주십시오",
  not_confirmed: "구매 확정한 주문만 확정을 취소할 수 있습니다",
  not_unconfirmed: "구매 확정을 취소한 주문만 다시 확정할 수 있습니다",
};

export const orderErrorBody = (code: OrderErrorCode, tone: MessageTone = "friendly") => ({
  error: code,
  message: (tone === "formal" ? ORDER_ERROR_MESSAGES_FORMAL : ORDER_ERROR_MESSAGES)[code],
});

// 구매 제한 안내: 풀리는 시각을 KST로 알려 준다. 예) 「11월 2일 오후 3시 5분부터 다시 주문할 수 있어요」(정각이면 분은 뺀다)
export function purchaseRestrictedMessage(endsAt: Date): string {
  // 초·밀리초가 있으면 분을 올림한다(안내 시각이 실제로 풀리는 시각보다 이르지 않게)
  const at = new Date(Math.ceil(endsAt.getTime() / 60_000) * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const h = Number(parts.hour);
  const m = Number(parts.minute);
  const clock = `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시${m ? ` ${m}분` : ""}`;
  return `${parts.month}월 ${parts.day}일 ${clock}부터 다시 주문할 수 있어요`;
}
