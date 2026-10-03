// 자동 설치·연결 상품 설정. 가격은 docs/PRODUCT_SCOPE.md 「자동 설치·연결 상품」(부가세 포함 일회성).
export const AUTOMATION_PRICE = 110_000;
export const AUTOMATION_ORDER_NAME = "자동 설치·연결";
// 재설치·환불 정책(2026-10-04 대표님 확정 ②, PRODUCT_SCOPE 「미확정 → 확정 ②」)
// 완료 뒤 30일 안 같은 쇼핑몰·같은 PC(OBS pairing) 재연결은 무료, 그 밖의 재설치는 33,000원(부가세 포함).
export const REINSTALL_PRICE = 33_000;
export const REINSTALL_ORDER_NAME = "자동 설치·연결 재설치";
export const FREE_RECONNECT_DAYS = 30;

// 결제 전 고지·동의. 화면 문구는 디자인 쪽이 정하고, 서버는 이 버전이 맞을 때만 결제를 만든다.
// 문구를 바꾸면 version을 올린다(예전 버전 동의로는 결제하지 않음).
export const AUTOMATION_CONSENT = {
  version: "2026-10-04",
  text: "연결을 시작한 뒤에는 단순 변심으로 환불받을 수 없어요. 테스트 주문이 OBS 화면에 보이지 않고 지원으로도 해결되지 않으면 전액 환불해 드려요.",
} as const;

export const AUTOMATION_LIMITS = {
  // 한 작업자가 실행 자리를 잡고 있는 시간. 이 안에 heartbeat로 늘리지 못하면 다른 작업자가 가져간다.
  leaseMs: 60_000,
  // 전체 동시 실행 작업 수(작업자 수와 무관한 상한)
  maxRunning: 20,
  // 한 단계에서 판단·실행을 반복하는 최대 횟수(무한 반복 방지)
  maxActionsPerStep: 12,
  // 고객 행동(로그인·인증 등)을 기다리는 시간. 지나면 실패로 닫는다.
  customerActionMs: 24 * 60 * 60_000,
  // 다시 시도 간격: 지수 증가 + 지터, 상한
  backoffBaseMs: 5_000,
  backoffCapMs: 10 * 60_000,
  // 결제 결과를 못 받은 청구를 PG에 다시 묻기 시작하는 나이, 기록이 없으면 실패로 닫는 나이
  reconcileAfterMs: 60_000,
  notChargedAfterMs: 30 * 60_000,
} as const;
