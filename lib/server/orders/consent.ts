// 결제 전 필수 동의(대표님 결정 2026-10-02, 문구는 2026-10-03 대표님 확정 v2, PRODUCT_SCOPE 「판매 방식과 환불 고지」).
// 문구를 바꾸면 버전을 올린다. 주문할 때 화면이 보여 준 버전을 함께 받아, 지금 버전과 다르면 다시 보여 주게 한다.
export const OPENED_NO_REFUND_CONSENT = {
  kind: "OPENED_NO_REFUND",
  version: "2026-10-03.v2",
  text: "개봉하면 단순 변심으로는 취소·환불이 안 돼요. 상품이 설명과 다르거나 잘못 왔으면 환불받을 수 있어요",
} as const;
