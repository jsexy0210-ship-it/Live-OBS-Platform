// 플랫폼 문의(SA-113·114·115) 화면 공통 값. API: /api/seller/platform-inquiries
export type InquiryCategory = "BILLING" | "ACCOUNT" | "FEATURE" | "BUG" | "OTHER";
export type InquiryStatus = "OPEN" | "ANSWERED" | "CLOSED";

export const INQUIRY_CATEGORY: Record<InquiryCategory, string> = { BILLING: "결제 · 구독", ACCOUNT: "계정", FEATURE: "기능 사용", BUG: "오류 신고", OTHER: "기타" };
export const INQUIRY_STATUS: Record<InquiryStatus, { label: string; cls: string }> = {
  OPEN: { label: "답변 대기", cls: "b-pending" },
  ANSWERED: { label: "답변 완료", cls: "b-done" },
  CLOSED: { label: "종료", cls: "b-gray nodot" },
};
export const INQUIRY_TITLE_MAX = 100;
export const INQUIRY_BODY_MAX = 5000;
export const INQUIRY_IMAGES_MAX = 5;
