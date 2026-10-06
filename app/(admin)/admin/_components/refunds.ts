import type { PaymentKind } from "./payments";

// 구독 환불 요청 응답과 표시 문구(GET·POST /api/admin/subscription-refunds, …/{id}, …/approve·reject, MA-026·027)
export type RefundStatus = "REQUESTED" | "PROCESSING" | "REFUNDED" | "FAILED" | "REJECTED";
export type Refund = {
  id: string;
  sellerId: string;
  shopName: string;
  slug: string;
  paymentId: string;
  amount: number;
  source: "SYSTEM" | "ADMIN";
  reason: string;
  status: RefundStatus;
  decisionNote: string | null;
  failureReason: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
  refundedAt: string | null;
  requestedByAdminId: string | null;
  decidedByAdminId: string | null;
  payment: { amount: number; kind: PaymentKind; periodStart: string; periodEnd: string; paidAt: string | null; receiptUrl: string | null };
};
export type RefundCounts = Record<RefundStatus, number>;
export type RefundListItem = Refund & { assignee: string | null };
export type RefundSummary = { monthRefunded: { count: number; amount: number }; avgProcessDays: number | null };

export const REFUND_STATUS: Record<RefundStatus, { label: string; cls: string }> = {
  REQUESTED: { label: "처리 대기", cls: "b-warn" },
  PROCESSING: { label: "처리 중", cls: "b-info" },
  REFUNDED: { label: "환불 완료", cls: "b-done" },
  FAILED: { label: "환불 실패", cls: "b-fail" },
  REJECTED: { label: "거절", cls: "b-gray" },
};
export const REFUND_TABS: (RefundStatus | "")[] = ["", "REQUESTED", "PROCESSING", "FAILED", "REFUNDED", "REJECTED"];
export const REFUND_SOURCE = { SYSTEM: "자동 요청", ADMIN: "관리자 요청" } as const;
// 시스템이 만든 요청의 사유 코드는 화면 문구로 바꾼다(코드성 표기 금지)
export const refundReason = (r: string) => (r === "paid_after_cancel" ? "해지 뒤 결제됨" : r);
