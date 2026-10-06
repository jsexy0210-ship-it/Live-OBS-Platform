// 로그인·세션 정책 (docs/ARCHITECTURE.md 3.1, 디자인 AU-001·AU-007).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 로그인 실패 잠금·IP 제한·2단계 인증은 두지 않는다(대표님 결정 2026-10-02). 실패는 감사 로그에 남긴다.

export type Realm = "admin" | "seller" | "buyer";

export const SESSION_POLICY: Record<Realm, { idleMs: number; maxMs: number }> = {
  admin: { idleMs: 30 * MINUTE, maxMs: 8 * HOUR },
  seller: { idleMs: 12 * HOUR, maxMs: 30 * DAY },
  buyer: { idleMs: 30 * DAY, maxMs: 30 * DAY },
};

// 판매자는 방송 LIVE 중 미활동 로그아웃을 하지 않고, 방송 종료 30분 뒤부터 다시 적용한다.
export const SELLER_LIVE_GRACE_MS = 30 * MINUTE;

export const COOKIE_NAMES: Record<Realm, string> = {
  admin: "lo_admin",
  seller: "lo_seller",
  buyer: "lo_buyer",
};

export type SessionTimes = {
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type BroadcastActivity = { live: boolean; lastEndedAt: Date | null };

// 미활동 기준 시각. 판매자는 방송 중이면 null(검사 안 함), 종료 후에는 종료+30분과 마지막 활동 중 늦은 시각.
export function idleReference(realm: Realm, lastSeenAt: Date, broadcast?: BroadcastActivity): Date | null {
  if (realm !== "seller" || !broadcast) return lastSeenAt;
  if (broadcast.live) return null;
  if (broadcast.lastEndedAt) {
    const graceEnd = new Date(broadcast.lastEndedAt.getTime() + SELLER_LIVE_GRACE_MS);
    return graceEnd > lastSeenAt ? graceEnd : lastSeenAt;
  }
  return lastSeenAt;
}

export function isSessionActive(realm: Realm, s: SessionTimes, now: Date, broadcast?: BroadcastActivity): boolean {
  if (s.revokedAt) return false;
  if (now >= s.expiresAt) return false;
  const ref = idleReference(realm, s.lastSeenAt, broadcast);
  if (ref && now.getTime() - ref.getTime() >= SESSION_POLICY[realm].idleMs) return false;
  return true;
}

// 구매자 「로그인 유지」를 끈 로그인(기본)의 세션 기간. 쿠키는 브라우저를 닫으면 사라지고, 서버 쪽도 이 기간이 지나면 끝난다.
// 켜면 SESSION_POLICY.buyer(30일)다.
export const BUYER_SHORT_SESSION_MS = DAY;

export function sessionExpiry(realm: Realm, now: Date, opts: { short?: boolean } = {}): Date {
  const ms = realm === "buyer" && opts.short ? BUYER_SHORT_SESSION_MS : SESSION_POLICY[realm].maxMs;
  return new Date(now.getTime() + ms);
}
