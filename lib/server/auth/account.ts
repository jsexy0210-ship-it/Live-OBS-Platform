import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { cleanStaffName } from "../sellers/staffName";
import type { TenantContext } from "../tenant/context";
import { hashPassword, verifyPassword } from "./password";
import { MIN_PASSWORD_LENGTH } from "./passwordReset";

// 내 계정(파트너스 SA-120 · 마스터 관리자 MA-090): 내 비밀번호 바꾸기(현재 비밀번호 확인)와 파트너스 내 이름 바꾸기. 본인 계정만 다루고 대상 id는 받지 않는다.
// - 비밀번호: 현재 비밀번호가 맞아야 하고, 새 비밀번호는 8~200자이며 현재와 달라야 한다. 「다른 곳에서 로그아웃(signOutOthers)」을 true·false로 반드시 정해서 보낸다(빠지면 400).
//   true면 이 세션만 남기고 다른 세션은 모두 끝낸다(파트너스는 자격 버전을 올려 옛 세션을 무효로 하고 이 세션에 새 버전을 준다). false면 다른 세션은 그대로다.
// - 로그 추적: 성공 auth.seller.password_change·auth.admin.password_change(다른 세션 정리 여부·끝낸 수), 현재 비밀번호가 틀리면 auth.*.password_change_failed, 횟수 제한에 막히면 auth.*.password_change_blocked. 비밀번호 값은 어디에도 남기지 않는다.
// - 마스터 대리 조회(읽기 전용)는 403. 최고관리자도 같은 길(본인만)이다.
export const PASSWORD_MAX = 200;
// 현재 비밀번호 시도 횟수 제한: 계정마다 15분 안에 5번 틀리면 그다음 시도는 429 rate_limited(비밀번호가 맞아도 확인하지 않고 막는다). 성공하면 처음부터 센다.
// 센 값은 로그 추적(auth.*.password_change_failed)에서 읽는 DB 기반이라 서버가 여러 대여도 같고, 계정 잠금(로그인 막기)은 하지 않는다. 막힌 시도도 로그 추적에 남긴다.
export const RATE_LIMIT_FAILURES = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
export type PasswordChangeRejection = "bad_request" | "weak_password" | "same_password" | "wrong_password" | "changed_elsewhere" | "rate_limited";
export const ACCOUNT_MESSAGES: Record<PasswordChangeRejection | "invalid_name", string> = {
  rate_limited: "현재 비밀번호를 여러 번 틀려 잠시 막았습니다. 잠시 뒤에 다시 시도해 주십시오",
  bad_request: "현재 비밀번호와 새 비밀번호를 입력하고, 다른 곳에서 로그아웃할지 골라 주십시오",
  weak_password: `새 비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상 ${PASSWORD_MAX}자 이하로 입력해 주십시오`,
  same_password: "현재 비밀번호와 다른 비밀번호를 입력해 주십시오",
  wrong_password: "현재 비밀번호가 맞지 않습니다",
  changed_elsewhere: "다른 곳에서 먼저 비밀번호를 바꿨습니다. 새로고침한 뒤 다시 시도해 주십시오",
  invalid_name: "이름을 50자 안에서 입력해 주십시오",
};
type Meta = { ip?: string | null; userAgent?: string | null };
type PasswordInput = { currentPassword?: unknown; newPassword?: unknown; signOutOthers?: unknown };

// 입력 검사. 현재 비밀번호는 길이 제한 없이 문자열이면 되고(맞는지만 본다), 새 비밀번호만 길이를 본다.
function parseInput(input: PasswordInput) {
  if (typeof input.currentPassword !== "string" || input.currentPassword === "" || typeof input.newPassword !== "string" || typeof input.signOutOthers !== "boolean") {
    return { ok: false as const, reason: "bad_request" as const };
  }
  if (input.newPassword.length < MIN_PASSWORD_LENGTH || input.newPassword.length > PASSWORD_MAX) return { ok: false as const, reason: "weak_password" as const };
  if (input.newPassword === input.currentPassword) return { ok: false as const, reason: "same_password" as const };
  return { ok: true as const, current: input.currentPassword, next: input.newPassword, signOutOthers: input.signOutOthers };
}

type Realm = "seller" | "admin";
const ACTIONS = {
  seller: { ok: "auth.seller.password_change", failed: "auth.seller.password_change_failed", blocked: "auth.seller.password_change_blocked", actorType: "SELLER_USER", targetType: "SellerUser" },
  admin: { ok: "auth.admin.password_change", failed: "auth.admin.password_change_failed", blocked: "auth.admin.password_change_blocked", actorType: "PLATFORM_ADMIN", targetType: "PlatformAdmin" },
} as const;

// 현재 비밀번호 확인 관문: 횟수 제한(15분 5번)을 먼저 보고, 막히지 않았을 때만 비밀번호를 확인한다. 계정별 advisory lock 안에서 세고·확인하고·실패를 남겨
// 동시에 여러 번 시도해도 제한을 넘기지 못한다.
async function currentPasswordGate(db: PrismaClient, realm: Realm, a: { actorId: string; sellerId?: string; hash: string; plain: string; now: Date }, meta: Meta) {
  const act = ACTIONS[realm];
  const entry = (action: string, after: Record<string, unknown>) =>
    ({ actorType: act.actorType, actorId: a.actorId, sellerId: a.sellerId, action, targetType: act.targetType, targetId: a.actorId, after, ip: meta.ip, userAgent: meta.userAgent }) as const;
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pwchange:${a.actorId}`}))`;
    const lastOk = await tx.auditLog.findFirst({ where: { action: act.ok, actorId: a.actorId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const windowStart = new Date(a.now.getTime() - RATE_LIMIT_WINDOW_MS);
    const since = lastOk && lastOk.createdAt > windowStart ? lastOk.createdAt : windowStart;
    const fails = await tx.auditLog.findMany({ where: { action: act.failed, actorId: a.actorId, createdAt: { gt: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    if (fails.length >= RATE_LIMIT_FAILURES) {
      const retryAfterSeconds = Math.max(1, Math.ceil((fails[0].createdAt.getTime() + RATE_LIMIT_WINDOW_MS - a.now.getTime()) / 1000));
      await writeAudit(tx, entry(act.blocked, { reason: "rate_limited", retryAfterSeconds }));
      return { state: "blocked" as const, retryAfterSeconds };
    }
    if (!(await verifyPassword(a.hash, a.plain))) {
      await writeAudit(tx, entry(act.failed, { reason: "wrong_password" }));
      return { state: "wrong" as const };
    }
    return { state: "ok" as const };
  });
}

export async function changeSellerPassword(db: PrismaClient, ctx: TenantContext, sessionId: string, input: PasswordInput, meta: Meta = {}, now = new Date()) {
  if (ctx.readOnly) throw forbidden();
  const p = parseInput(input);
  if (!p.ok) return p;
  const user = await db.sellerUser.findFirst({ where: { id: ctx.actorId, sellerId: ctx.sellerId, status: "ACTIVE" }, select: { id: true, passwordHash: true, credentialVersion: true } });
  if (!user) throw forbidden();
  const gate = await currentPasswordGate(db, "seller", { actorId: user.id, sellerId: ctx.sellerId, hash: user.passwordHash, plain: p.current, now }, meta);
  if (gate.state === "blocked") return { ok: false as const, reason: "rate_limited" as const, retryAfterSeconds: gate.retryAfterSeconds };
  if (gate.state === "wrong") return { ok: false as const, reason: "wrong_password" as const };
  const passwordHash = await hashPassword(p.next);
  return db.$transaction(async (tx) => {
    // 확인한 뒤 다른 곳에서 먼저 바꿨으면(해시가 달라짐) 덮어쓰지 않는다
    const nextVersion = user.credentialVersion + (p.signOutOthers ? 1 : 0);
    const upd = await tx.sellerUser.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash, credentialVersion: nextVersion } });
    if (upd.count !== 1) return { ok: false as const, reason: "changed_elsewhere" as const };
    let signedOut = 0;
    if (p.signOutOthers) {
      await tx.sellerSession.updateMany({ where: { id: sessionId, sellerUserId: user.id }, data: { credentialVersion: nextVersion } });
      signedOut = (await tx.sellerSession.updateMany({ where: { sellerUserId: user.id, revokedAt: null, id: { not: sessionId } }, data: { revokedAt: now } })).count;
    }
    await writeAudit(tx, {
      actorType: "SELLER_USER",
      actorId: user.id,
      sellerId: ctx.sellerId,
      action: "auth.seller.password_change",
      targetType: "SellerUser",
      targetId: user.id,
      after: { signOutOthers: p.signOutOthers, signedOutSessions: signedOut },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, signedOutOthers: p.signOutOthers, signedOutSessions: signedOut };
  });
}

// 내 이름 바꾸기(파트너스). 직원 이름과 같은 정규화(NFKC·제어 문자 거부·50자)를 쓴다. 이름은 직원 본인확인 연결을 푸는 값이 아니다(휴대폰이 바뀔 때만 풀린다).
export async function renameSellerUser(db: PrismaClient, ctx: TenantContext, rawName: unknown, meta: Meta = {}) {
  if (ctx.readOnly) throw forbidden();
  const name = cleanStaffName(rawName);
  if (!name) return { ok: false as const, reason: "invalid_name" as const };
  return db.$transaction(async (tx) => {
    const before = await tx.sellerUser.findFirst({ where: { id: ctx.actorId, sellerId: ctx.sellerId, status: "ACTIVE" }, select: { id: true, name: true } });
    if (!before) throw forbidden();
    if (before.name !== name) {
      await tx.sellerUser.update({ where: { id: before.id }, data: { name } });
      await writeAudit(tx, {
        actorType: "SELLER_USER",
        actorId: before.id,
        sellerId: ctx.sellerId,
        action: "auth.seller.name_change",
        targetType: "SellerUser",
        targetId: before.id,
        before: { name: before.name },
        after: { name },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return { ok: true as const, name };
  });
}

// 마스터 관리자 본인 비밀번호(MA-090). 모든 역할이 본인 것만. 세션은 revokedAt로 끝낸다(이 세션은 남김).
export async function changeAdminPassword(db: PrismaClient, adminId: string, sessionId: string, input: PasswordInput, meta: Meta = {}, now = new Date()) {
  const p = parseInput(input);
  if (!p.ok) return p;
  const admin = await db.platformAdmin.findFirst({ where: { id: adminId, status: "ACTIVE" }, select: { id: true, passwordHash: true } });
  if (!admin) throw forbidden();
  const gate = await currentPasswordGate(db, "admin", { actorId: admin.id, hash: admin.passwordHash, plain: p.current, now }, meta);
  if (gate.state === "blocked") return { ok: false as const, reason: "rate_limited" as const, retryAfterSeconds: gate.retryAfterSeconds };
  if (gate.state === "wrong") return { ok: false as const, reason: "wrong_password" as const };
  const passwordHash = await hashPassword(p.next);
  return db.$transaction(async (tx) => {
    const upd = await tx.platformAdmin.updateMany({ where: { id: admin.id, passwordHash: admin.passwordHash }, data: { passwordHash } });
    if (upd.count !== 1) return { ok: false as const, reason: "changed_elsewhere" as const };
    const signedOut = p.signOutOthers ? (await tx.adminSession.updateMany({ where: { adminId: admin.id, revokedAt: null, id: { not: sessionId } }, data: { revokedAt: now } })).count : 0;
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.id,
      action: "auth.admin.password_change",
      targetType: "PlatformAdmin",
      targetId: admin.id,
      after: { signOutOthers: p.signOutOthers, signedOutSessions: signedOut },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, signedOutOthers: p.signOutOthers, signedOutSessions: signedOut };
  });
}
