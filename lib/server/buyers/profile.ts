import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { hashPassword, verifyPassword } from "../auth/password";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { cleanText } from "../text/clean";
import { MAX_PASSWORD_LENGTH } from "./passwordReset";
import { MAX_NICKNAME_LENGTH } from "./signup";

// 구매자 회원정보 수정(SH-024): 내 정보 조회, 방송 닉네임 변경(30일에 1번), 비밀번호 변경(현재 비밀번호 확인).
// 아이디·이름은 바꿀 수 없다. 휴대폰 번호 변경은 본인확인을 다시 거치는 별도 흐름이다.
export const NICKNAME_CHANGE_INTERVAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
// 현재 비밀번호를 틀린 횟수 제한: 같은 회원이 10분에 5번 넘게 틀리면 잠시 막는다(로그인한 세션이 비밀번호를 알아내는 시도 방지).
export const PASSWORD_CHANGE_FAIL_LIMIT = 5;
export const PASSWORD_CHANGE_FAIL_WINDOW_MS = 10 * 60_000;

export const PROFILE_MESSAGES = {
  invalid_nickname: "방송 닉네임은 20자까지, 쓸 수 있는 글자로 정해 주세요",
  nickname_taken: "이미 쓰고 있는 방송 닉네임이에요. 다른 닉네임으로 정해 주세요",
  nickname_change_limited: "닉네임은 30일에 1번만 바꿀 수 있어요",
  weak_password: "새 비밀번호는 8자 이상으로 정해 주세요",
  wrong_password: "현재 비밀번호가 맞지 않아요",
  same_password: "지금 쓰는 비밀번호와 다른 비밀번호로 정해 주세요",
  too_many_attempts: "비밀번호를 여러 번 틀렸어요. 잠시 뒤에 다시 해 주세요",
  not_found: "회원 정보를 찾을 수 없어요",
} as const;
export type ProfileFailure = keyof typeof PROFILE_MESSAGES;
export const PROFILE_STATUS: Record<ProfileFailure, number> = {
  invalid_nickname: 400,
  nickname_taken: 409,
  nickname_change_limited: 409,
  weak_password: 400,
  wrong_password: 403,
  same_password: 400,
  too_many_attempts: 429,
  not_found: 404,
};

type Scope = { sellerId: string; buyerMemberId: string; sessionId?: string };
type Meta = { ip?: string | null; userAgent?: string | null; now?: Date };

// 010-****-1234(11자리) · 010-***-1234(10자리). 모양이 다르면 끝 4자리만.
export function maskPhone(phone: string): string {
  if (/^\d{11}$/.test(phone)) return `${phone.slice(0, 3)}-****-${phone.slice(7)}`;
  if (/^\d{10}$/.test(phone)) return `${phone.slice(0, 3)}-***-${phone.slice(6)}`;
  return `***${phone.slice(-4)}`;
}

const nextChangeAt = (changedAt: Date | null): Date | null => (changedAt ? new Date(changedAt.getTime() + NICKNAME_CHANGE_INTERVAL_DAYS * DAY_MS) : null);

const SELECT = { loginId: true, name: true, phone: true, broadcastNickname: true, broadcastNicknameChangedAt: true } as const;
type Row = { loginId: string; name: string; phone: string; broadcastNickname: string; broadcastNicknameChangedAt: Date | null };

// nextNicknameChangeAt: 닉네임을 다시 바꿀 수 있는 시각(ISO). 지금 바꿀 수 있으면 null.
function viewOf(m: Row, now: Date) {
  const next = nextChangeAt(m.broadcastNicknameChangedAt);
  return {
    loginId: m.loginId,
    name: m.name,
    phoneMasked: maskPhone(m.phone),
    broadcastNickname: m.broadcastNickname,
    nextNicknameChangeAt: next && next > now ? next.toISOString() : null,
  };
}

export async function readMemberProfile(db: PrismaClient, scope: Scope, now = new Date()) {
  const m = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null, status: "ACTIVE" }, select: SELECT });
  return m ? viewOf(m, now) : null;
}

// 본문 { broadcastNickname }. 지금과 같으면 바꾸지 않고(30일 제한도 쓰지 않고) 그대로 돌려준다. 같은 쇼핑몰 회원 사이에서 겹치면 409.
export async function changeBroadcastNickname(db: PrismaClient, scope: Scope, raw: unknown, meta: Meta = {}) {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nickname = cleanText(b.broadcastNickname, MAX_NICKNAME_LENGTH);
  if (!nickname) return { ok: false as const, reason: "invalid_nickname" as const };
  const now = meta.now ?? new Date();
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE`;
    if (locked.length === 0) return { ok: false as const, reason: "not_found" as const };
    const cur = await tx.buyerMember.findUniqueOrThrow({ where: { id: scope.buyerMemberId }, select: SELECT });
    if (cur.broadcastNickname === nickname) return { ok: true as const, changed: false, profile: viewOf(cur, now) };
    const next = nextChangeAt(cur.broadcastNicknameChangedAt);
    if (next && next > now) return { ok: false as const, reason: "nickname_change_limited" as const, nextNicknameChangeAt: next.toISOString() };
    const taken = await tx.buyerMember.findFirst({ where: { sellerId: scope.sellerId, deletedAt: null, broadcastNickname: nickname, NOT: { id: scope.buyerMemberId } }, select: { id: true } });
    if (taken) return { ok: false as const, reason: "nickname_taken" as const };
    const updated = await tx.buyerMember.update({ where: { id: scope.buyerMemberId }, data: { broadcastNickname: nickname, broadcastNicknameChangedAt: now }, select: SELECT });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: scope.buyerMemberId,
      sellerId: scope.sellerId,
      action: "buyer.profile.nickname_change",
      targetType: "BuyerMember",
      targetId: scope.buyerMemberId,
      before: { broadcastNickname: cur.broadcastNickname },
      after: { broadcastNickname: nickname },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, changed: true, profile: viewOf(updated, now) };
  });
}

// 비밀번호 변경: 본문 { currentPassword, newPassword }. 현재 비밀번호가 맞아야 하고(틀리면 10분 5번까지), 새 비밀번호는 가입·재설정과 같은 기준(8자 이상)이다.
// 바꾸면 지금 쓰는 세션만 남기고 이 회원의 다른 로그인 세션은 모두 무효화한다.
const failures = new Map<string, number[]>(); // memberId → 틀린 시각들(프로세스 안, 서버 한 대 기준)
export function resetPasswordChangeLimiter() {
  failures.clear();
}
function recentFailures(memberId: string, now: number): number[] {
  const list = (failures.get(memberId) ?? []).filter((t) => now - t < PASSWORD_CHANGE_FAIL_WINDOW_MS);
  if (list.length === 0) failures.delete(memberId);
  else failures.set(memberId, list);
  if (failures.size > 20_000) failures.clear();
  return list;
}

export async function changeMemberPassword(db: PrismaClient, scope: Scope, raw: unknown, meta: Meta = {}) {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const { currentPassword, newPassword } = b;
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) return { ok: false as const, reason: "weak_password" as const };
  if (typeof currentPassword !== "string" || currentPassword.length === 0 || currentPassword.length > MAX_PASSWORD_LENGTH) return { ok: false as const, reason: "wrong_password" as const };
  const nowMs = (meta.now ?? new Date()).getTime();
  if (recentFailures(scope.buyerMemberId, nowMs).length >= PASSWORD_CHANGE_FAIL_LIMIT) return { ok: false as const, reason: "too_many_attempts" as const };
  const m = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null, status: "ACTIVE" }, select: { passwordHash: true } });
  if (!m) return { ok: false as const, reason: "not_found" as const };
  if (!(await verifyPassword(m.passwordHash, currentPassword))) {
    failures.set(scope.buyerMemberId, [...recentFailures(scope.buyerMemberId, nowMs), nowMs]);
    await writeAudit(db, { actorType: "BUYER", actorId: scope.buyerMemberId, sellerId: scope.sellerId, action: "buyer.profile.password_change.failed", reason: "wrong_password", ip: meta.ip, userAgent: meta.userAgent });
    return { ok: false as const, reason: "wrong_password" as const };
  }
  if (currentPassword === newPassword) return { ok: false as const, reason: "same_password" as const };
  const passwordHash = await hashPassword(newPassword);
  const now = meta.now ?? new Date();
  const revoked = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR NO KEY UPDATE`;
    if (locked.length === 0) return null;
    await tx.buyerMember.update({ where: { id: scope.buyerMemberId }, data: { passwordHash } });
    const r = await tx.buyerSession.updateMany({
      where: { buyerMemberId: scope.buyerMemberId, revokedAt: null, ...(scope.sessionId ? { NOT: { id: scope.sessionId } } : {}) },
      data: { revokedAt: now },
    });
    // 아직 안 쓴 비밀번호 재설정 링크도 쓸 수 없게 한다
    await tx.buyerPasswordReset.deleteMany({ where: { buyerMemberId: scope.buyerMemberId, usedAt: null } });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: scope.buyerMemberId,
      sellerId: scope.sellerId,
      action: "buyer.profile.password_change",
      targetType: "BuyerMember",
      targetId: scope.buyerMemberId,
      after: { revokedSessions: r.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return r.count;
  });
  if (revoked === null) return { ok: false as const, reason: "not_found" as const };
  failures.delete(scope.buyerMemberId);
  return { ok: true as const, revokedSessions: revoked };
}
