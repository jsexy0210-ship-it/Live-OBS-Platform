import type { AutomationJobStatus } from "@prisma/client";

// 연결 작업 상태기계(docs/AUTOMATION.md 2절). 결제 상태는 AutomationPayment에 따로 있다.
// 모든 상태 변경은 이 표를 거친다: 쓰기 조건(where status in ...)을 여기서 만든다.
export const TRANSITIONS: Record<AutomationJobStatus, readonly AutomationJobStatus[]> = {
  AWAITING_PAYMENT: ["QUEUED", "FAILED", "CANCELED"],
  QUEUED: ["RUNNING", "CANCELED"],
  RUNNING: ["VERIFYING", "NEEDS_CUSTOMER", "QUEUED", "FAILED", "CANCELED", "CLEANUP_NEEDED"],
  NEEDS_CUSTOMER: ["QUEUED", "FAILED", "CANCELED"],
  VERIFYING: ["SUCCEEDED", "NEEDS_CUSTOMER", "QUEUED", "FAILED", "CANCELED", "CLEANUP_NEEDED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELED: [],
  // 사람이 정리한 뒤 실패로 닫는다(판매자 취소·재개 불가, 열린 작업이라 새 구매도 막힌다)
  CLEANUP_NEEDED: ["FAILED"],
};

export const TERMINAL: readonly AutomationJobStatus[] = ["SUCCEEDED", "FAILED", "CANCELED"];
// 실행 자리(lease)를 잡고 있는 상태
export const LEASED: readonly AutomationJobStatus[] = ["RUNNING", "VERIFYING"];

export const canTransition = (from: AutomationJobStatus, to: AutomationJobStatus) => TRANSITIONS[from].includes(to);

// to로 갈 수 있는 출발 상태 목록
export function sourcesOf(to: AutomationJobStatus): AutomationJobStatus[] {
  return (Object.keys(TRANSITIONS) as AutomationJobStatus[]).filter((from) => canTransition(from, to));
}
