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
  PENDING: { label: "승인 대기", cls: "b-wait" },
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

export const day = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : "-";
export const dayTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))
    : "-";
export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
export const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : "-");
