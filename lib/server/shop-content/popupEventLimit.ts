import type { PopupEventType } from "./service";

// 팝업 노출·반응 집계(로그인 없음)의 접속(IP)별 과다 호출 제한. 같은 접속이 같은 팝업에 같은 종류를 1시간에 60번 넘게 보내면 더 받지 않는다.
// 상품 검색어 집계(shop-search/service.ts allowSearchCount)와 같은 방식이라 프로세스 안에서만 기억한다(서버 한 대 기준, 재시작하면 비워짐).
// 접속 IP를 알 수 없으면(신뢰 프록시 없음) 모두 한 접속으로 본다.
export const POPUP_EVENT_BUDGET = 60;
export const POPUP_EVENT_WINDOW_MS = 60 * 60_000;
const LIMITER_MAX_ENTRIES = 20_000;
const budgets = new Map<string, { count: number; resetAt: number }>(); // `${popupId}|${type}|${ip}`

export function resetPopupEventLimiter() {
  budgets.clear();
}

export function allowPopupEvent(popupId: string, type: PopupEventType, ip: string | null, now = Date.now()): boolean {
  if (budgets.size > LIMITER_MAX_ENTRIES) {
    for (const [k, b] of budgets) if (b.resetAt <= now) budgets.delete(k);
    // 그래도 많으면 통째로 비운다. 한도가 잠깐 풀려도 서버 메모리가 먼저다.
    if (budgets.size > LIMITER_MAX_ENTRIES) budgets.clear();
  }
  const key = `${popupId}|${type}|${ip ?? "unknown"}`;
  const b = budgets.get(key);
  if (b && b.resetAt > now) {
    if (b.count >= POPUP_EVENT_BUDGET) return false;
    b.count += 1;
    return true;
  }
  budgets.set(key, { count: 1, resetAt: now + POPUP_EVENT_WINDOW_MS });
  return true;
}
