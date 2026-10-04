import { ROLE_LABEL, type AdminRoleCode } from "./accounts";

// 로그 추적(코드·DB 이름은 audit) 응답과 표시 문구(GET /api/admin/audit-logs, …/{id}, MA-070·071). 화면에는 action·역할 코드를 쓰지 않고 이름으로 보인다.
export type ActorType = "PLATFORM_ADMIN" | "SELLER_USER" | "BUYER" | "SYSTEM";
export type AuditRow = {
  id: string;
  createdAt: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  ip: string | null;
  seller: { id: string; slug: string; shopName: string } | null;
};
export type AuditDetail = AuditRow & {
  before: unknown;
  after: unknown;
  userAgent: string | null;
  actorAdmin: { name: string; email: string; role: AdminRoleCode } | null;
};

export const ACTOR_LABEL: Record<ActorType, string> = { PLATFORM_ADMIN: "마스터 관리자", SELLER_USER: "파트너스", BUYER: "구매자", SYSTEM: "시스템" };

// 종류 필터(서버는 「.」으로 끝나는 값을 접두어로 찾는다). 아래 목록 순서가 선택지 순서다
export const ACTION_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "admin.account.", label: "관리자 계정" },
  { prefix: "admin.seller.", label: "파트너스 승인·정지" },
  { prefix: "admin.plan.", label: "요금제 변경" },
  { prefix: "admin.impersonate.", label: "파트너스 화면 대리 조회" },
  { prefix: "auth.", label: "로그인·비밀번호" },
  { prefix: "seller.", label: "파트너스 가입·직원" },
  { prefix: "subscription.", label: "구독·결제" },
  { prefix: "order.", label: "주문" },
  { prefix: "buyer.", label: "구매자" },
  { prefix: "product.", label: "상품" },
  { prefix: "broadcast.", label: "방송" },
  { prefix: "automation.", label: "자동 연결" },
];

const EXACT: Record<string, string> = {
  "admin.account.create": "관리자 계정 추가",
  "admin.account.update": "관리자 계정 수정",
  "admin.seller.approve": "파트너스 가입 승인",
  "admin.seller.reject": "파트너스 가입 반려",
  "admin.seller.suspend": "파트너스 이용 정지",
  "admin.seller.unsuspend": "파트너스 정지 해제",
  "admin.seller.view": "파트너스 상세 열람",
  "admin.impersonate.view": "파트너스 화면 대리 조회",
  "admin.plan.price_update": "요금제 가격 변경",
  "admin.plan.trial_limits_update": "체험 한도 변경",
  "branding.text.update": "파비콘·공유 카드 문구 변경",
  "seller.apply": "파트너스 가입 신청",
  "seller.auto_approve": "파트너스 가입 자동 승인",
  "seller.staff.create": "직원 계정 추가",
  "seller.staff.disable": "직원 계정 정지",
  "seller.staff.permissions": "직원 권한 변경",
  "seller.staff.profile": "직원 정보 변경",
  "seller.staff.password_reset": "직원 비밀번호 재설정",
  "subscription.cancel": "구독 해지 신청",
  "subscription.canceled": "구독 해지",
  "subscription.card_registered": "결제 카드 등록",
  "subscription.card_rejected": "결제 카드 거절",
  "subscription.restored": "구독 되살림",
  "subscription.auto_closed": "구독 자동 종료",
  "order.create": "주문 생성",
  "order.paid": "주문 결제",
  "order.cancel": "주문 취소",
  "order.refund": "주문 환불",
  "order.purchase_confirmed": "구매 확정",
  "order.purchase_unconfirm": "구매 확정 취소",
  "buyer.signup": "구매자 가입",
  "buyer.withdraw": "구매자 탈퇴",
  "buyer.purchase_restriction.create": "구매 제한",
  "buyer.purchase_restriction.lift": "구매 제한 해제",
  "customer.pii.view": "구매자 개인정보 열람",
  "product.create": "상품 등록",
  "product.update": "상품 수정",
  "product.delete": "상품 삭제",
  "broadcast.start": "방송 시작",
  "broadcast.end": "방송 종료",
  "overlay.token.issue": "오버레이 주소 발급",
};
export function actionLabel(action: string): string {
  if (EXACT[action]) return EXACT[action];
  const g = ACTION_GROUPS.find((x) => action.startsWith(x.prefix));
  return g ? `${g.label} 기록` : "기타 기록";
}

const TARGET: Record<string, string> = { Seller: "파트너스", PlatformAdmin: "관리자 계정", Order: "주문", Product: "상품", SubscriptionPayment: "청구", SellerSubscription: "구독" };
export const targetLabel = (t: string | null) => (t ? (TARGET[t] ?? "기타") : "-");

// 바뀐 값(before·after) 표시: 자주 나오는 항목 이름과 값은 한글로, 나머지는 받은 그대로
const KEY: Record<string, string> = {
  name: "이름",
  email: "이메일",
  role: "역할",
  status: "상태",
  suspendedReason: "정지 사유",
  revokedSessions: "끝낸 로그인 수",
  price: "가격",
};
export const keyLabel = (k: string) => KEY[k] ?? k;
const STATUS_VALUE: Record<string, string> = { ACTIVE: "이용 중", SUSPENDED: "정지", PENDING: "승인 대기", REJECTED: "반려", CLOSED: "종료" };
export function valueText(k: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (k === "role" && typeof v === "string") return ROLE_LABEL[v as AdminRoleCode] ?? v;
  if (k === "status" && typeof v === "string") return STATUS_VALUE[v] ?? v;
  if (typeof v === "boolean") return v ? "예" : "아니요";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
export const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
