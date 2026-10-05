// 자동 연결 작업 상태 표시(MA-110·111 공통)
export const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  AWAITING_PAYMENT: { label: "결제 대기", cls: "b-wait" },
  QUEUED: { label: "대기", cls: "b-wait" },
  RUNNING: { label: "실행 중", cls: "b-live" },
  VERIFYING: { label: "검증 중", cls: "b-live" },
  NEEDS_CUSTOMER: { label: "고객 확인 대기", cls: "b-warn" },
  SUCCEEDED: { label: "완료", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
  CANCELED: { label: "취소", cls: "b-gray" },
  CLEANUP_NEEDED: { label: "정리 필요", cls: "b-fail" },
};
export const PAY_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "결제 확인 중", cls: "b-wait" },
  PAID: { label: "결제 확인", cls: "b-done" },
  FAILED: { label: "결제 실패", cls: "b-fail" },
  REFUND_PENDING: { label: "환불 대기", cls: "b-warn" },
  REFUNDED: { label: "환불 완료", cls: "b-gray" },
};
