// 직원 본인확인 연결 흐름의 쿠키(시작한 브라우저에만, 이 경로에서만 보냄)
export const STAFF_LINK_PATH = "/api/seller/me/identity";
export const STAFF_LINK_IDV_COOKIE = "lo_lidv";

// 실패 사유별 화면 문구(파트너스 관리자, 합니다체)
export const STAFF_LINK_MESSAGES = {
  phone_not_registered: "등록된 휴대폰 번호가 없습니다. 대표자에게 번호 등록을 요청해 주십시오",
  identity_mismatch: "등록된 직원 정보와 맞지 않습니다. 대표자에게 확인해 주십시오",
  link_limit_exceeded: "오늘은 더 인증할 수 없습니다. 내일 다시 시도해 주십시오",
  verification_invalid: "본인확인을 처음부터 다시 해 주십시오",
} as const;
