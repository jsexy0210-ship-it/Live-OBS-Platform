// 플랫폼 문의(SA-113·114·115) 화면 공통 값. API: /api/seller/platform-inquiries
// 작성 종류는 SA-114 정본 8종(서버 CATEGORIES와 같은 값). BILLING·FEATURE·BUG는 예전에 보낸 문의에만 남아 있어 보기에서만 쓴다.
export const INQUIRY_WRITE_CATEGORIES = ["BROADCAST", "PAYMENT_LINK", "ORDER_REFUND", "REWARD", "SUBSCRIPTION_FEE", "SHOP", "ACCOUNT", "OTHER"] as const;
export type InquiryCategory = (typeof INQUIRY_WRITE_CATEGORIES)[number] | "BILLING" | "FEATURE" | "BUG";
export type InquiryStatus = "OPEN" | "ANSWERED" | "CLOSED";

export const INQUIRY_CATEGORY: Record<InquiryCategory, string> = {
  BROADCAST: "방송 화면",
  PAYMENT_LINK: "결제 연결",
  ORDER_REFUND: "주문 · 환불",
  REWARD: "적립금",
  SUBSCRIPTION_FEE: "구독 · 요금",
  SHOP: "쇼핑몰",
  ACCOUNT: "계정 · 직원",
  OTHER: "기타",
  BILLING: "결제 · 이용권",
  FEATURE: "기능 사용",
  BUG: "오류 알리기",
};
export const INQUIRY_STATUS: Record<InquiryStatus, { label: string; cls: string }> = {
  OPEN: { label: "답변 대기", cls: "b-pending" },
  ANSWERED: { label: "답변 완료", cls: "b-done" },
  CLOSED: { label: "종료", cls: "b-gray nodot" },
};
export const INQUIRY_TITLE_MAX = 100;
export const INQUIRY_BODY_MAX = 5000;
export const INQUIRY_IMAGES_MAX = 5;
