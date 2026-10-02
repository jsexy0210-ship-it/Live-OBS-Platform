import { describe, expect, it } from "vitest";
import { isLocked, isSessionActive, nextLockStateAfterFailure, sessionExpiry } from "../../lib/server/auth/policy";

const t0 = new Date("2026-10-02T12:00:00Z");
const min = (n: number) => new Date(t0.getTime() + n * 60_000);

describe("로그인 잠금 (5번 틀리면 10분)", () => {
  it("4번째까지는 횟수만 늘린다", () => {
    let s = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < 4; i++) s = nextLockStateAfterFailure(s, t0);
    expect(s.failedLoginCount).toBe(4);
    expect(isLocked(s, t0)).toBe(false);
  });

  it("5번째에 10분 잠그고 10분 뒤 풀린다", () => {
    const s = nextLockStateAfterFailure({ failedLoginCount: 4, lockedUntil: null }, t0);
    expect(s.lockedNow).toBe(true);
    expect(s.failedLoginCount).toBe(0);
    expect(isLocked(s, min(9))).toBe(true);
    expect(isLocked(s, min(10))).toBe(false);
  });
});

describe("세션 시간", () => {
  const live = (now: Date) => ({ lastSeenAt: t0, expiresAt: sessionExpiry("admin", t0), revokedAt: null, now });

  it("마스터: 미활동 30분이면 만료", () => {
    expect(isSessionActive("admin", live(min(29)), min(29))).toBe(true);
    expect(isSessionActive("admin", live(min(30)), min(30))).toBe(false);
  });

  it("마스터: 계속 활동해도 최대 8시간", () => {
    const s = { lastSeenAt: min(479), expiresAt: sessionExpiry("admin", t0), revokedAt: null };
    expect(isSessionActive("admin", s, min(479))).toBe(true);
    expect(isSessionActive("admin", s, min(480))).toBe(false);
  });

  it("폐기된 세션은 거부", () => {
    expect(isSessionActive("admin", { lastSeenAt: t0, expiresAt: min(60), revokedAt: t0 }, min(1))).toBe(false);
  });

  const seller = { lastSeenAt: t0, expiresAt: sessionExpiry("seller", t0), revokedAt: null };

  it("판매자: 미활동 12시간이면 만료", () => {
    expect(isSessionActive("seller", seller, min(12 * 60 - 1))).toBe(true);
    expect(isSessionActive("seller", seller, min(12 * 60))).toBe(false);
  });

  it("판매자: 방송 LIVE 중에는 미활동 로그아웃 없음", () => {
    expect(isSessionActive("seller", seller, min(20 * 60), { live: true, lastEndedAt: null })).toBe(true);
  });

  it("판매자: 방송 종료 30분 뒤부터 미활동 시간을 다시 센다", () => {
    const ended = { live: false, lastEndedAt: min(20 * 60) };
    // 종료 시각 + 30분 + 12시간 직전까지 유지
    expect(isSessionActive("seller", seller, min(20 * 60 + 30 + 12 * 60 - 1), ended)).toBe(true);
    expect(isSessionActive("seller", seller, min(20 * 60 + 30 + 12 * 60), ended)).toBe(false);
  });
});
