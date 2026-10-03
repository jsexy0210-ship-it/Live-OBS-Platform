// 자동 설치·연결 상품 설정. 가격은 docs/PRODUCT_SCOPE.md 「자동 설치·연결 상품」(부가세 포함 일회성).
export const AUTOMATION_PRICE = 110_000;
export const AUTOMATION_ORDER_NAME = "자동 설치·연결";

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
