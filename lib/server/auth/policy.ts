// 로그인·세션 정책 (docs/ARCHITECTURE.md 3.1, 디자인 AU-001·AU-007).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LOGIN_LOCK = { maxFailures: 5, lockMs: 10 * MINUTE } as const;

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

export function sessionExpiry(realm: Realm, now: Date): Date {
  return new Date(now.getTime() + SESSION_POLICY[realm].maxMs);
}

export type LockState = { failedLoginCount: number; lockedUntil: Date | null };

export function isLocked(s: LockState, now: Date): boolean {
  return !!s.lockedUntil && s.lockedUntil > now;
}

// 실패 1회를 반영한 다음 상태. 5회째에 10분 잠그고 횟수를 0으로 되돌린다.
export function nextLockStateAfterFailure(s: LockState, now: Date): LockState & { lockedNow: boolean } {
  const count = s.failedLoginCount + 1;
  if (count >= LOGIN_LOCK.maxFailures) {
    return { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOGIN_LOCK.lockMs), lockedNow: true };
  }
  return { failedLoginCount: count, lockedUntil: s.lockedUntil, lockedNow: false };
}
