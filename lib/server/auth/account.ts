import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { cleanStaffName } from "../sellers/staffName";
import type { TenantContext } from "../tenant/context";
import { hashPassword, verifyPassword } from "./password";
import { MIN_PASSWORD_LENGTH } from "./passwordReset";

// 내 계정(파트너스 SA-120 · 마스터 관리자 MA-090): 내 비밀번호 바꾸기(현재 비밀번호 확인)와 파트너스 내 이름 바꾸기. 본인 계정만 다루고 대상 id는 받지 않는다.
// - 비밀번호: 현재 비밀번호가 맞아야 하고, 새 비밀번호는 8~200자이며 현재와 달라야 한다. 「다른 곳에서 로그아웃(signOutOthers)」을 true·false로 반드시 정해서 보낸다(빠지면 400).
//   true면 이 세션만 남기고 다른 세션은 모두 끝낸다(파트너스는 자격 버전을 올려 옛 세션을 무효로 하고 이 세션에 새 버전을 준다). false면 다른 세션은 그대로다.
// - 로그 추적: 성공 auth.seller.password_change·auth.admin.password_change(다른 세션 정리 여부·끝낸 수), 현재 비밀번호가 틀리면 auth.*.password_change_failed. 비밀번호 값은 어디에도 남기지 않는다.
// - 마스터 대리 조회(읽기 전용)는 403. 최고관리자도 같은 길(본인만)이다.
export const PASSWORD_MAX = 200;
export type PasswordChangeRejection = "bad_request" | "weak_password" | "same_password" | "wrong_password" | "changed_elsewhere";
export const ACCOUNT_MESSAGES: Record<PasswordChangeRejection | "invalid_name", string> = {
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

export async function changeSellerPassword(db: PrismaClient, ctx: TenantContext, sessionId: string, input: PasswordInput, meta: Meta = {}, now = new Date()) {
  if (ctx.readOnly) throw forbidden();
  const p = parseInput(input);
  if (!p.ok) return p;
  const user = await db.sellerUser.findFirst({ where: { id: ctx.actorId, sellerId: ctx.sellerId, status: "ACTIVE" }, select: { id: true, passwordHash: true, credentialVersion: true } });
  if (!user) throw forbidden();
  const audit = (action: string, extra?: Record<string, unknown>) =>
    writeAudit(db, { actorType: "SELLER_USER", actorId: user.id, sellerId: ctx.sellerId, action, targetType: "SellerUser", targetId: user.id, after: extra, ip: meta.ip, userAgent: meta.userAgent });
  if (!(await verifyPassword(user.passwordHash, p.current))) {
    await audit("auth.seller.password_change_failed", { reason: "wrong_password" });
    return { ok: false as const, reason: "wrong_password" as const };
  }
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
  if (!(await verifyPassword(admin.passwordHash, p.current))) {
    await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.id, action: "auth.admin.password_change_failed", targetType: "PlatformAdmin", targetId: admin.id, after: { reason: "wrong_password" }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: false as const, reason: "wrong_password" as const };
  }
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
