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
// 목록 응답(GET /api/admin/sellers, MA-011): 표시 상태·번호·카드 결제 연결·방송·이번 달 주문·회원·최근 활동·실제 지급·메모 수. 연락처는 응답에 없다.
export type DisplayStatus = "NORMAL" | "TRIAL" | "OVERDUE" | "LOCKED" | "SUSPENDED" | "CLOSED" | "PENDING" | "REJECTED";
export type SellerListRow = SellerRow & {
  seq: number;
  displayStatus: DisplayStatus;
  representativeName: string | null;
  pg: { status: "OK" | "ERROR" | "NONE"; lastSuccessAt: string | null; lastFailureAt: string | null };
  live: boolean;
  ordersThisMonth: number;
  memberCount: number;
  lastActivityAt: string | null;
  payoutEnabled: boolean;
  noteCount: number;
};
export type SellerListSummary = {
  total: number;
  normal: number;
  trial: number;
  overdue: number;
  locked: number;
  suspended: number;
  closed: number;
  pgError: number;
  pgNone: number;
  payoutEnabled: number;
  live: number;
  pendingApplications: number;
};
export const DISPLAY_STATUS: Record<DisplayStatus, { label: string; cls: string }> = {
  NORMAL: { label: "정상", cls: "b-done" },
  TRIAL: { label: "체험 중", cls: "b-info" },
  OVERDUE: { label: "연체", cls: "b-warn" },
  LOCKED: { label: "이용 기간 끝", cls: "b-gray" },
  SUSPENDED: { label: "이용 정지", cls: "b-fail" },
  CLOSED: { label: "탈퇴", cls: "b-gray" },
  PENDING: { label: "가입 신청 중", cls: "b-wait" },
  REJECTED: { label: "반려", cls: "b-gray" },
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

export const day = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : "-";
export const dayTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))
    : "-";
// 가입일 표시: 2026.10.06 (새 날짜 표기 규칙, 한국 시간)
export const dotDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", ".") : "-");
// 한국 시간 기준 오늘(YYYY-MM-DD)에서 며칠·몇 달 전 날짜
export function kstDate(daysAgo = 0, monthsAgo = 0): string {
  const [y, m, d] = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 - monthsAgo, d - daysAgo));
  return t.toISOString().slice(0, 10);
}
// 최근 활동 시각 → 「1분 전」「어제」
export function ago(iso: string | null): string {
  if (!iso) return "—";
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  const d = Math.floor(min / (24 * 60));
  return d === 1 ? "어제" : `${d}일 전`;
}
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
