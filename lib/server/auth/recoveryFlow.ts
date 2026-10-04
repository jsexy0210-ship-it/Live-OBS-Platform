// 파트너스 아이디 찾기(쇼핑몰을 모르는 계정 찾기) 흐름의 쿠키. 시작한 브라우저에만 주고 이 경로에서만 보낸다.
export const RECOVERY_PATH = "/api/seller/find-id";
export const RECOVERY_IDV_COOKIE = "lo_fidv";
// 같은 휴대폰·같은 IP 하루 한도를 넘었을 때(비밀번호 찾기와 같은 안내)
export const RECOVERY_LIMIT_MESSAGE = "오늘은 더 인증할 수 없습니다. 내일 다시 시도해 주십시오";

export const parseAccountType = (v: unknown): "owner" | "staff" | null => (v === "owner" || v === "staff" ? v : null);
