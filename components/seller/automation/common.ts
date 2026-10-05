import { formatDateTime } from "../../../lib/client/format";
// 자동 연결(SA-150~153) 공통 값. 서버 응답 모양은 lib/server/automation/jobs.ts JobView와 같다. 화면 문구는 파트너스 관리자 말투(명사형 버튼·합니다체).
export type JobStatus = "AWAITING_PAYMENT" | "QUEUED" | "RUNNING" | "NEEDS_CUSTOMER" | "VERIFYING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "CLEANUP_NEEDED";
export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "REFUND_PENDING" | "REFUNDED";
export type CustomerAction = "LOGIN" | "TWO_FACTOR" | "CAPTCHA" | "PERMISSION_GRANT" | "LOCAL_TOOL";
export type Job = {
  id: string;
  kind: "INITIAL" | "REINSTALL" | "RECONNECT_FREE";
  status: JobStatus;
  paymentStatus: PaymentStatus | null;
  amount: number;
  step: string | null;
  stepNumber: number;
  stepCount: number;
  customerAction: CustomerAction | null;
  actionDeadlineAt: string | null;
  lastError: string | null;
  verifiedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export const OPEN_STATUSES: JobStatus[] = ["AWAITING_PAYMENT", "QUEUED", "RUNNING", "NEEDS_CUSTOMER", "VERIFYING", "CLEANUP_NEEDED"];
export const STEP_LABEL: Record<string, string> = {
  shop_connect: "다른 쇼핑몰 이어 주기",
  webhook_setup: "주문 알림 연결",
  obs_overlay_install: "방송 프로그램에 방송 화면 넣기",
  display_settings: "주문 표시 설정",
  test_event_verify: "테스트 확인",
};
export const ACTION_TEXT: Record<CustomerAction, string> = {
  LOGIN: "쇼핑몰 관리자에 로그인해 주십시오",
  TWO_FACTOR: "문자 인증을 마쳐 주십시오",
  CAPTCHA: "그림 속 글자가 뜨면 직접 입력해 주십시오",
  PERMISSION_GRANT: "쇼핑몰에서 앱 설치를 허용해 주십시오",
  LOCAL_TOOL: "방송용 컴퓨터에 연결 프로그램을 설치해 주십시오",
};
// 서버가 내보내는 실패 사유 코드(publicError) → 안내. 모르는 코드는 일반 문구
const ERROR_TEXT: Record<string, string> = {
  payment_failed: "결제되지 않았습니다",
  customer_action_timeout: "24시간 안에 확인이 끝나지 않아 실패로 처리했습니다",
  cost_limit: "자동 연결을 끝내지 못했습니다. 「자동 연결 다시 하기」를 누르거나 직접 설정을 이용해 주십시오",
  budget_limit: "이번 달 자동 설정 접수 한도를 넘어 멈췄습니다. 다음 달에 다시 신청하거나 직접 설정을 이용해 주십시오",
  verification_missing: "테스트 주문이 방송 화면에 나오는지 확인하지 못했습니다. 「자동 연결 다시 하기」를 누르거나 직접 설정을 이용해 주십시오",
  run_time_limit: "처리 시간이 너무 길어 멈췄습니다. 「자동 연결 다시 하기」를 눌러 주십시오",
  start_deadline: "정해진 시간 안에 시작하지 못했습니다. 「자동 연결 다시 하기」를 눌러 주십시오",
  total_deadline: "정해진 시간 안에 끝내지 못했습니다. 「자동 연결 다시 하기」를 눌러 주십시오",
  obs_target_busy: "방송용 컴퓨터가 다른 작업 중입니다. 잠시 뒤 「자동 연결 다시 하기」를 눌러 주십시오",
  canceled: "취소했습니다",
};
export const errorText = (code: string | null) => (code ? (ERROR_TEXT[code] ?? "자동 연결을 끝내지 못했습니다. 「자동 연결 다시 하기」를 누르거나 직접 설정을 이용해 주십시오") : "");
export const stamp = (iso: string) => formatDateTime(iso);
