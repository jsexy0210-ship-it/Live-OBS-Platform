import { PLAN_FILTER } from "./partners";

// 청구·결제 내역 응답과 표시 문구(GET /api/admin/payments, …/{id}, MA-024·025).
export type PaymentStatus = "PENDING" | "PAID" | "FAILED";
export type PaymentKind = "PERIOD" | "PRORATION";
export type PaymentRow = {
  id: string;
  seller: { id: string; slug: string; shopName: string };
  amount: number;
  status: PaymentStatus;
  kind: PaymentKind;
  periodStart: string;
  periodEnd: string;
  scheduled: boolean;
  launchDiscount: boolean;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
  targetPlanCode: string | null;
};
export type PaymentDetail = PaymentRow & {
  providerPaymentId: string | null;
  receiptUrl: string | null;
  subscription: { status: string; cardLabel: string | null; plan: { code: string; name: string } };
};

export const PAYMENT_STATUS: Record<PaymentStatus, { label: string; cls: string }> = {
  PENDING: { label: "결제 대기", cls: "b-wait" },
  PAID: { label: "결제 완료", cls: "b-done" },
  FAILED: { label: "결제 실패", cls: "b-fail" },
};
export const PAYMENT_KIND: Record<PaymentKind, string> = { PERIOD: "이용 기간 결제", PRORATION: "차액 결제" };

// 상위 변경 청구의 대상 요금제는 API가 코드만 줘서 화면 이름으로 바꾼다(코드성 표기 금지)
export const planLabel = (code: string | null) => (code ? (PLAN_FILTER.find((p) => p.code === code)?.label ?? "-") : "-");
// 카드 매출전표 주소는 http(s)만 링크로 쓴다
export const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);
