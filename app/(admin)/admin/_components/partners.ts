import { formatDate, formatDateTime } from "../../../../lib/client/format";
// 파트너스(seller) 목록·상세 응답과 표시 문구(GET /api/admin/sellers, …/{id}, MA-011·012). 코드·DB 이름은 seller 그대로 둔다.
export type SellerStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | "CLOSED";
export type SubscriptionStatus = "ACTIVE" | "PAST_DUE" | "CANCELED";
export type PlanRef = { code: string; name: string };
export type SellerRow = {
  id: string;
  slug: string;
  shopName: string;
  status: SellerStatus;
  plan: PlanRef | null;
  subscription: { status: SubscriptionStatus; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
  trialEndsAt: string | null;
  approvedAt: string | null;
  createdAt: string;
};
export type SellerDetail = {
  id: string;
  slug: string;
  shopName: string;
  status: SellerStatus;
  businessInfo: Record<string, unknown> | null;
  suspendedReason: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
  approvedAt: string | null;
  trialEndsAt: string | null;
  serviceEndedAt: string | null;
  createdAt: string;
  plan: PlanRef | null;
  owner: { name: string; email: string; status: string; lastLoginAt: string | null } | null;
  subscription: {
    status: SubscriptionStatus;
    cardLabel: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    nextChargeAt: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
    retryCount: number;
    planCode: string;
    planName: string;
    pendingPlanCode: string | null;
    pendingPlanName: string | null;
  } | null;
  orders30d: { since: string; created: number; paid: number; paidAmount: number; lastOrderAt: string | null };
};

export const SELLER_STATUS: Record<SellerStatus, { label: string; cls: string }> = {
  PENDING: { label: "가입 신청 중", cls: "b-wait" },
  ACTIVE: { label: "운영 중", cls: "b-done" },
  SUSPENDED: { label: "이용 정지", cls: "b-fail" },
  REJECTED: { label: "반려", cls: "b-gray" },
  CLOSED: { label: "종료", cls: "b-gray" },
};
export const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "이용 중", cls: "b-done" },
  PAST_DUE: { label: "연체", cls: "b-warn" },
  CANCELED: { label: "해지", cls: "b-gray" },
};
export const PLAN_FILTER = [
  { code: "OVERLAY_ONLY", label: "오버레이 전용" },
  { code: "INTEGRATED", label: "쇼핑몰 통합" },
  { code: "STANDARD", label: "월 구독" },
] as const;

// 일시·날짜는 공용 서식(lib/client/format.ts, 「2026.10.05 22:25」)을 쓴다. 값이 없으면 「-」
export const day = (iso: string | null) => formatDate(iso, "-");
export const dayTime = (iso: string | null) => formatDateTime(iso, "-");
export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
export const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : "-");

// 가입 신청(MA-013·014): GET /api/admin/sellers/review 응답과 「확인 필요」 사유 문구
export type ReviewRow = { id: string; slug: string; shopName: string; businessInfo: Record<string, unknown> | null; reviewReasons: string[]; createdAt: string };
export const REVIEW_REASON: Record<string, string> = {
  business_lookup_failed: "국세청 조회 실패",
  business_info_mismatch: "사업자 정보 불일치",
  business_not_active: "휴업·폐업 사업자",
  business_duplicate: "같은 사업자번호의 쇼핑몰 있음",
  mail_order_number_invalid: "통신판매업 신고번호 확인 필요",
  mail_order_lookup_failed: "통신판매업 조회 실패",
  mail_order_not_registered: "통신판매업 등록 없음",
  mail_order_not_active: "통신판매업 영업 상태 확인 필요",
};
export const reasonLabel = (code: string) => REVIEW_REASON[code] ?? "확인 필요";
