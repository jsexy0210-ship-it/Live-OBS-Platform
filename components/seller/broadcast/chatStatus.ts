// 유튜브 채팅 수집 상태(GET /api/seller/youtube/live/chat-status) 안내 문구. 방송 대시보드 띠와 유튜브 연결 화면이 함께 쓴다.
// state: off | waiting | collecting | paused | unavailable | ended, reason은 서버 코드(lib/server/youtube/chat.ts chatStateOf).
export type ChatStatus = {
  link: { id: string; status: "upcoming" | "live" | "ended" | "unlinked" } | null;
  state: "off" | "waiting" | "collecting" | "paused" | "unavailable" | "ended" | null;
  reason: string | null;
  lastCollectedAt: string | null;
};

const PAUSED: Record<string, string> = {
  platform_limit: "플랫폼 전체 무료 사용량이 차서 채팅 수집이 일시 중지됐습니다. 사용량이 풀리면 자동으로 다시 시작합니다.",
  seller_daily_limit: "오늘 이 쇼핑몰의 무료 사용량을 모두 써서 채팅 수집이 일시 중지됐습니다. 내일 자동으로 다시 시작합니다.",
  youtube_error: "유튜브가 일시적으로 응답하지 않아 채팅 수집이 잠시 멈췄습니다. 1분 뒤 자동으로 다시 시도합니다.",
};
const UNAVAILABLE: Record<string, string> = {
  chat_forbidden: "이 방송은 비공개 또는 회원 전용이라 채팅을 가져올 수 없습니다. 유튜브에서 공개로 바꾸면 다음 확인부터 표시됩니다.",
  chat_not_found: "이 방송의 채팅을 찾을 수 없습니다. 유튜브에서 채팅이 켜져 있는지 확인해 주십시오.",
  // 채팅이 꺼진 방송과 유튜브가 채팅을 주지 않는 방송은 같은 안내
  chat_disabled: "이 방송은 채팅을 쓸 수 없습니다. 유튜브에서 채팅이 꺼져 있거나 채팅을 지원하지 않는 방송입니다.",
  no_live_chat: "이 방송은 채팅을 쓸 수 없습니다. 유튜브에서 채팅이 꺼져 있거나 채팅을 지원하지 않는 방송입니다.",
};

export type ChatNotice = { tone: "cau" | "inf"; title: string; text: string } | null;

// 띠로 알릴 상태만 돌려준다(수집 중·꺼짐·시작 전·종료는 알릴 것이 없음). 주문 처리·오버레이는 영향이 없다
export function chatNotice(s: ChatStatus | null): ChatNotice {
  if (!s?.link || !s.state || !s.reason) return null;
  if (s.state === "paused") return { tone: "cau", title: "채팅 수집 일시 중지", text: PAUSED[s.reason] ?? "채팅 수집이 일시 중지됐습니다." };
  if (s.state === "unavailable") return { tone: "cau", title: "채팅을 받을 수 없음", text: UNAVAILABLE[s.reason] ?? "이 방송의 채팅을 받을 수 없습니다." };
  if (s.state === "ended" && s.reason === "chat_ended") return { tone: "inf", title: "채팅 종료", text: "방송 중 채팅이 종료되어 더 이상 수집하지 않습니다." };
  return null;
}
