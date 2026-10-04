// 본인확인을 마친 뒤 이어지는 단계(계정 조회·재설정 권한·비밀번호 저장·직원 연결·가입 신청)의 실패를 가른다.
// - unavailable: 본인확인 서비스 준비 중(503) → 준비 중 화면
// - retry: 연결 끊김·응답 없음·서버 오류(5xx) → 본인확인을 버리지 않고 같은 단계를 다시 시도하게 한다.
//   저장 계열(비밀번호·직원 연결)은 결과가 불분명하므로 화면이 상태를 다시 확인하거나 로그인 안내를 보여 준다.
// - restart: 서버가 본인확인을 다시 해야 한다고 분명히 알린 경우(그 단계가 정한 오류 코드)만 처음으로 돌려보낸다
// - other: 그 밖의 분명한 거절(4xx) → 화면이 그 단계에 맞게 처리한다(본인확인은 버리지 않는다)
export type StepOutcome = "unavailable" | "retry" | "restart" | "other";

// 여러 단계가 공통으로 「본인확인을 다시 해야 한다」는 뜻으로 쓰는 오류 코드
export const RESTART_ERRORS = ["recovery_not_allowed", "verification_invalid", "expired", "already_verified"] as const;

export function stepOutcome(r: { status: number; error: string }, restartErrors: readonly string[] = RESTART_ERRORS): StepOutcome {
  if (r.status === 503) return "unavailable";
  if (r.status === 0 || r.status >= 500) return "retry";
  if (restartErrors.includes(r.error)) return "restart";
  return "other";
}

// 같은 단계를 다시 시도하게 할 때의 안내(연결 끊김은 공통 api()의 문구, 서버 오류는 이 문구)
export const RETRY_TEXT = "잠시 후 다시 시도해 주십시오";
export const RETRY_TEXT_PUBLIC = "잠시 후 다시 시도해 주세요";
