// SA-001 방송 대시보드에서 쓰는 주문대기 자료형과 문구. 서버 응답 모양은 lib/server/queue/read.ts의 getQueueSnapshot.

export type QueueStatus = "WAITING" | "OPENING" | "DONE" | "CANCELLED";
export type QueueItem = {
  id: string;
  status: QueueStatus;
  position: number;
  receivedAt: string;
  nicknameSnapshot: string;
  gradeSnapshot: string | null;
  productLabel: string;
  quantity: number;
  timerSeconds: number;
  openingStartedAt: string | null;
  doneAt: string | null;
  version: number;
  broadcastSessionId: string | null;
  // 스냅샷에만 있다(개봉·완료·취소 같은 동작 응답에는 없다). 외부 쇼핑몰 주문이면 "EXTERNAL"
  source?: "INTERNAL" | "EXTERNAL";
};
export type Snapshot = {
  version: number;
  broadcast: { id: string; title: string | null; startedAt: string } | null;
  opening: QueueItem | null;
  waiting: QueueItem[];
  beforeBroadcast: QueueItem[];
  recentDone: QueueItem[];
};

// 서버 규칙과 같은 값(lib/server/queue/rules.ts). 화면은 버튼 표시에만 쓰고 판정은 서버가 한다.
export const REVERT_WINDOW_MS = 10_000;
export const TIMER_MAX_SECONDS = 3600;
export const TIMER_STEP = 30;

// 거부 사유별 안내(서버는 error 코드만 준다)
const REJECT_TEXT: Record<string, string> = {
  invalid_transition: "이미 상태가 바뀌었습니다. 최신 내용으로 다시 불러왔습니다",
  conflict: "다른 화면에서 먼저 바뀌었습니다. 최신 내용으로 다시 불러왔습니다",
  other_opening: "개봉 중인 주문이 있습니다. 먼저 완료해 주십시오",
  not_live: "방송 중이 아닙니다. 방송을 시작해 주십시오",
  revert_expired: "완료 후 10초가 지나 되돌릴 수 없습니다",
  invalid_timer: "타이머는 0초부터 60분까지 정할 수 있습니다",
  already_live: "이미 방송 중입니다",
  opening_in_progress: "개봉 중인 주문이 있어 종료할 수 없습니다. 먼저 완료하거나 취소해 주십시오",
  reason_required: "취소 사유를 입력해 주십시오",
  not_found: "주문을 찾을 수 없습니다. 최신 내용으로 다시 불러왔습니다",
};
export const rejectText = (error: string): string | undefined => REJECT_TEXT[error];

// 결과를 알 수 없는 실패: 연결 끊김(0)·서버 오류(5xx). 성공으로 추정하지 않고 다시 읽어 확인한다.
export const isUnclearFailure = (status: number) => status === 0 || status >= 500;

// 0:00 형식(60분 이상은 쓰지 않는다)
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// 한국 시간 HH:mm
export function kstTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// 개봉 중 타이머: 정했으면 남은 시간, 안 정했으면 지난 시간. 화면 시계 기준이라 서버와 몇 초 다를 수 있다.
export function openingClock(item: QueueItem, now: number): { label: string; text: string; over: boolean } {
  const started = item.openingStartedAt ? new Date(item.openingStartedAt).getTime() : now;
  const elapsed = (now - started) / 1000;
  if (item.timerSeconds > 0) {
    const left = item.timerSeconds - elapsed;
    return { label: "남은 시간", text: clock(Math.ceil(left)), over: left <= 0 };
  }
  return { label: "개봉 시간", text: clock(elapsed), over: false };
}
