// 발송 비용 설정(GET·PUT /api/admin/message-settings, POST /api/admin/message-prices/{channel}, POST /api/admin/plans/{code}/mail-quota, MA-086·MA-022) 응답과 표시 문구.
// 화면에는 채널·요금제 코드를 쓰지 않고 이름으로 보인다(코드성 표기 금지).
export type MessageChannel = "MAIL_TRANSACTIONAL" | "MAIL_BULK" | "SMS" | "LMS" | "ALIMTALK" | "IDENTITY_VERIFICATION" | "DELIVERY_TRACKING" | "INVOICE_ISSUE" | "INVOICE_LABEL" | "CASH_RECEIPT" | "TAX_INVOICE";
export type ChannelPrice = { channel: MessageChannel; unitPrice: number; next: { unitPrice: number; effectiveAt: string } | null };
export type PlanQuota = { code: string; name: string; mailMonthlyQuota: number; next: { mailMonthlyQuota: number; effectiveAt: string } | null };
export type AdminPlan = {
  code: string;
  name: string;
  listPrice: number;
  salePrice: number;
  trialDays: number;
  trialMessageLimit: number;
  trialIdentityLimit: number;
  trialStorageMb: number;
  mailMonthlyQuota: number;
  next: { mailMonthlyQuota: number; effectiveAt: string } | null;
};
// 서버(updatePlanPrice·updateTrialLimits)와 같은 상한
export const PRICE_MAX = 100_000_000;
export const TRIAL_LIMIT_MAX = 10_000_000;
export type MessageSettings = {
  chargingEnabled: boolean;
  platformDailyLimit: number;
  platformMonthlyLimit: number;
  noticeVersion: string;
  prices: ChannelPrice[];
  plans: PlanQuota[];
  usage: { month: string; today: { used: number; limit: number }; thisMonth: { used: number; limit: number }; skippedPlatformLimit: number };
};

export const CHANNEL_LABEL: Record<MessageChannel, string> = {
  MAIL_TRANSACTIONAL: "주문·배송 안내 메일(무료 수량을 넘은 것)",
  MAIL_BULK: "광고·공지 대량 메일",
  SMS: "단문 문자",
  LMS: "장문 문자",
  ALIMTALK: "알림톡",
  IDENTITY_VERIFICATION: "구매자 본인인증",
  DELIVERY_TRACKING: "배송 자동 조회",
  INVOICE_ISSUE: "송장 발급",
  INVOICE_LABEL: "송장 라벨",
  CASH_RECEIPT: "현금영수증",
  TAX_INVOICE: "전자세금계산서",
};
export const UNIT_PRICE_MAX = 100_000;
export const MAIL_QUOTA_MAX_UI = 10_000_000;

// 적용 예정 시각 입력(datetime-local, KST) → 서버가 받는 ISO 시각. 비우면 undefined(바로 적용)
export function effectiveAtIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(`${local}:00+09:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
