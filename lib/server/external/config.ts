// 외부 쇼핑몰 연동 설정(환경변수로만). 키가 없으면 연동 기능 전체가 꺼진다(「준비 중」).
// 아래 값 중 scope 이름·서명 헤더 이름은 공식 문서를 직접 확인하지 못한 값이라 환경변수로 바꿀 수 있게 두었다(docs/EXTERNAL_SHOP.md 「미검증」).
export type ExternalConfig = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  signatureHeader: string;
};

export function externalConfig(env: Record<string, string | undefined> = process.env): ExternalConfig {
  const clientId = env.EXTERNAL_SHOP_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.EXTERNAL_SHOP_CLIENT_SECRET?.trim() ?? "";
  const redirectUri = env.EXTERNAL_SHOP_REDIRECT_URI?.trim() ?? "";
  return {
    enabled: !!clientId && !!clientSecret && /^https:\/\//.test(redirectUri),
    clientId,
    clientSecret,
    redirectUri,
    scopes: env.EXTERNAL_SHOP_SCOPES?.trim() || "mall.read_order",
    signatureHeader: (env.EXTERNAL_WEBHOOK_SIGNATURE_HEADER?.trim() || "x-cafe24-hmac-sha256").toLowerCase(),
  };
}

// 연결 시작 state 유효 시간, 웹훅 본문 크기 상한
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const MAX_WEBHOOK_BYTES = 256 * 1024;
// 보관 기간: 웹훅 원본은 받은 날부터 30일(MASTER 제안, 대표님 확인 대기 — 바꾸려면 이 값만 고친다), 끝난 OAuth state는 만료 1일 뒤 삭제
export const WEBHOOK_RETENTION_DAYS = 30;
export const OAUTH_STATE_KEEP_MS = 24 * 3600_000;
// 토큰 갱신: 갱신 토큰이 이 시간 안에 만료되거나 접근 토큰이 이미 만료됐으면 갱신한다. 한 번 돌 때 쓰는 시간 상한(작업 트랜잭션 60초 안)
export const REFRESH_AHEAD_MS = 3 * 24 * 3600_000;
export const REFRESH_BUDGET_MS = 40_000;
// 쇼핑몰당 호출 한도(10분 3,000건)의 안전선 70%. 주문 보정 조회가 이 선에서 멈춘다(보정 PR에서 사용).
export const CALL_LIMIT_PER_10_MIN = 3000;
export const CALL_SAFETY_RATIO = 0.7;
