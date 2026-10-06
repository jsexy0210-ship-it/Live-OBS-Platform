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
  // 잠시 멈추기(SA-152): 멈춘 상태면 paused=true(상태는 QUEUED로 보임)
  paused: boolean;
  pausedAt: string | null;
  // 고객 확인 대기일 때만 5줄(로그인·2단계 인증·보안문자·앱 권한·OBS 도구), 그 밖에는 빈 배열
  customerChecklist: { action: CustomerAction; done: boolean; current: boolean }[];
  // 대기열에서 순서를 기다리는 작업만(앞에 몇 개 · 예상 시작 분), 그 밖에는 null
  queue: { ahead: number; etaMinutes: number } | null;
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
// 「지금 해 주실 일」 표의 줄 문구와 「완료」 버튼 이름(정본 SA-152)
export const CHECK_TEXT: Record<CustomerAction, { text: string; done: string }> = {
  LOGIN: { text: "쇼핑몰 관리자에 로그인해 주십시오", done: "로그인 완료" },
  TWO_FACTOR: { text: "2단계 인증을 완료해 주십시오", done: "인증 완료" },
  CAPTCHA: { text: "보안문자가 뜨면 직접 입력해 주십시오", done: "입력 완료" },
  PERMISSION_GRANT: { text: "ONQ 앱 설치 권한을 승인해 주십시오", done: "승인 완료" },
  LOCAL_TOOL: { text: "방송용 PC에 OBS 연결 도구를 설치해 주십시오", done: "설치 완료" },
};
// 작업 기록(GET …/timeline)의 한 줄 종류 → 안내 문구
export type TimelineEntry = { at: string; kind: string; stepNumber: number | null; reason: string | null };
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
// 작업 기록 한 줄의 내용. 사유는 서버가 정해 둔 코드만 주므로 그대로 안내 문구로 바꾼다(비밀번호·인증번호는 기록에 없다)
export function timelineText(e: TimelineEntry): string {
  const step = e.stepNumber ? ` · ${e.stepNumber}단계` : "";
  switch (e.kind) {
    case "payment_confirmed": return "결제 확인 완료 · 작업 시작";
    case "started": return `작업을 시작했습니다${step}`;
    case "needs_customer": return `직접 해 주실 일이 있습니다 · 고객 확인 대기${step}`;
    case "resumed": return `이어서 진행합니다${step}`;
    case "verifying": return "테스트 주문 이벤트를 보냈습니다 · 방송 화면 확인 중";
    case "retry": return `다시 시도합니다${step}${e.reason ? ` · ${errorText(e.reason)}` : ""}`;
    case "paused": return `잠시 멈췄습니다${step}`;
    case "continued": return `이어 했습니다${step}`;
    case "succeeded": return "완료 · 실제 표시까지 확인했습니다";
    case "failed": return e.reason ? errorText(e.reason) : "자동 연결을 끝내지 못했습니다";
    case "canceled": return "자동 연결을 취소했습니다";
    case "cleanup_needed": return "바꾼 설정을 원래대로 되돌립니다";
    default: return "진행 중입니다";
  }
}
