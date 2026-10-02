import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden, notFound } from "../authz/errors";
import type { IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, startIdentityVerification } from "../identity/verification";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { hashPassword } from "./password";
import { generateToken, hashToken } from "./token";
import { normalizeEmail } from "./login";

// 판매자 비밀번호 찾기: 대표자 PASS 본인인증으로만 한다(메일 링크 없음, 대표님 지시 2026-10-02).
// 1) 이메일+쇼핑몰로 시작 → 2) PASS 완료 후 CI가 쇼핑몰 대표자 CI와 같고 계정이 대표(OWNER)면 일회용·10분 재설정 권한 발급
// → 3) 새 비밀번호 저장, 그 계정의 기존 세션 모두 폐기. 계정이 있는지 없는지는 응답으로 드러나지 않는다.

const GRANT_TTL_MS = 10 * 60_000;

// 라우트 쿠키(시작한 브라우저 확인용·재설정 권한). 비밀번호 찾기 API 경로에서만 보낸다.
export const RESET_PATH = "/api/seller/password-reset";
export const IDV_COOKIE = "lo_idv";
export const GRANT_COOKIE = "lo_pwreset";
export const MIN_PASSWORD_LENGTH = 8;

type Meta = { ip?: string | null; userAgent?: string | null; now?: Date };

export async function startSellerPasswordReset(
  db: PrismaClient,
  provider: IdentityProvider,
  input: { email: string; shopSlug: string },
  meta: Meta = {},
) {
  const seller = await db.seller.findUnique({ where: { slug: input.shopSlug }, select: { id: true } });
  const user = seller
    ? await db.sellerUser.findUnique({
        where: { sellerId_email: { sellerId: seller.id, email: normalizeEmail(input.email) } },
        select: { id: true },
      })
    : null;
  // 계정이 없어도 똑같이 인증을 시작한다(응답 모양이 같다).
  const { verification, ownerToken } = await startIdentityVerification(db, provider, {
    purpose: "PASSWORD_RESET",
    sellerId: seller?.id ?? null,
    subjectId: user?.id ?? null,
    now: meta.now,
  });
  await writeAudit(db, {
    actorType: "SELLER_USER",
    actorId: user?.id ?? null,
    sellerId: seller?.id ?? null,
    action: "auth.seller.password_reset.start",
    targetType: "IdentityVerification",
    targetId: verification.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { verificationId: verification.id, requestId: verification.requestId, ownerToken };
}

export type GrantResult = { ok: true; grantToken: string; expiresAt: Date } | { ok: false; reason: "reset_not_allowed" | "pending" };

// PASS 완료 확인 → 대표자 CI 비교 → 재설정 권한 발급. 실패 사유는 하나로 묶는다(계정 존재·CI 일치 여부 비노출).
export async function issueSellerPasswordResetGrant(
  db: PrismaClient,
  provider: IdentityProvider,
  input: { verificationId: string; ownerToken: string | undefined },
  meta: Meta = {},
): Promise<GrantResult> {
  const now = meta.now ?? new Date();
  const v = await db.identityVerification.findUnique({ where: { id: input.verificationId } });
  const failAudit = async (reason: string, sellerId: string | null = v?.sellerId ?? null) =>
    writeAudit(db, {
      actorType: "SELLER_USER",
      actorId: v?.subjectId ?? null,
      sellerId,
      action: "auth.seller.password_reset.failed",
      targetType: "IdentityVerification",
      targetId: input.verificationId,
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  if (!v || v.purpose !== "PASSWORD_RESET") {
    await failAudit("verification_not_found", null);
    return { ok: false, reason: "reset_not_allowed" };
  }

  const done = await completeIdentityVerification(
    db,
    provider,
    v.id,
    { sellerId: v.sellerId, purpose: "PASSWORD_RESET", ownerToken: input.ownerToken },
    now,
  );
  if (!done.ok) {
    if (done.reason === "pending") return { ok: false, reason: "pending" };
    await failAudit(`verification_${done.reason}`);
    return { ok: false, reason: "reset_not_allowed" };
  }

  const user = v.subjectId
    ? await db.sellerUser.findUnique({ where: { id: v.subjectId }, include: { seller: { select: { representativeCiHash: true } } } })
    : null;
  const ci = done.verification.ciHash;
  if (!user || user.sellerId !== v.sellerId) {
    await failAudit("account_not_found");
    return { ok: false, reason: "reset_not_allowed" };
  }
  if (user.role !== "OWNER") {
    await failAudit("not_owner");
    return { ok: false, reason: "reset_not_allowed" };
  }
  if (!ci || !user.seller.representativeCiHash || user.seller.representativeCiHash !== ci) {
    await failAudit("ci_mismatch");
    return { ok: false, reason: "reset_not_allowed" };
  }

  const grantToken = generateToken();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS);
  const issued = await db.$transaction(async (tx) => {
    // 같은 본인인증으로 재설정 권한을 두 번 받지 못한다.
    const used = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null }, data: { consumedAt: now } });
    if (used.count !== 1) return false;
    await tx.passwordResetGrant.create({
      data: { sellerId: user.sellerId, sellerUserId: user.id, tokenHash: hashToken(grantToken), expiresAt, createdAt: now },
    });
    return true;
  });
  if (!issued) {
    await failAudit("verification_already_used");
    return { ok: false, reason: "reset_not_allowed" };
  }
  await writeAudit(db, {
    actorType: "SELLER_USER",
    actorId: user.id,
    sellerId: user.sellerId,
    action: "auth.seller.password_reset.granted",
    targetType: "SellerUser",
    targetId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true, grantToken, expiresAt };
}

export type ResetResult = { ok: true } | { ok: false; reason: "invalid_grant" | "weak_password" };

// 재설정 권한으로 새 비밀번호 저장. 권한은 한 번만 쓰이고, 그 계정의 기존 세션은 모두 폐기한다.
export async function resetSellerPassword(
  db: PrismaClient,
  input: { grantToken: string | undefined; newPassword: string },
  meta: Meta = {},
): Promise<ResetResult> {
  const now = meta.now ?? new Date();
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  if (!input.grantToken) return { ok: false, reason: "invalid_grant" };
  const passwordHash = await hashPassword(input.newPassword);
  const tokenHash = hashToken(input.grantToken);

  const grant = await db.$transaction(async (tx) => {
    const used = await tx.passwordResetGrant.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) return null;
    const g = await tx.passwordResetGrant.findUniqueOrThrow({ where: { tokenHash } });
    await tx.sellerUser.update({ where: { id: g.sellerUserId }, data: { passwordHash } });
    const revoked = await tx.sellerSession.updateMany({ where: { sellerUserId: g.sellerUserId, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, {
      actorType: "SELLER_USER",
      actorId: g.sellerUserId,
      sellerId: g.sellerId,
      action: "auth.seller.password_reset.completed",
      targetType: "SellerUser",
      targetId: g.sellerUserId,
      after: { revokedSessions: revoked.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return g;
  });
  if (!grant) {
    await writeAudit(db, {
      actorType: "SELLER_USER",
      action: "auth.seller.password_reset.failed",
      reason: "invalid_grant",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: false, reason: "invalid_grant" };
  }
  return { ok: true };
}

// 직원(매니저·방송 담당) 비밀번호는 대표가 직원 관리에서 재설정한다. 같은 쇼핑몰 직원만, 대표 계정은 대상이 아니다.
export async function resetStaffPassword(
  db: PrismaClient,
  ctx: TenantContext,
  input: { staffUserId: string; newPassword: string },
  meta: Meta = {},
): Promise<ResetResult> {
  requireSellerPermission(ctx, "staff.manage");
  const now = meta.now ?? new Date();
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  const staff = await db.sellerUser.findFirst({ where: { id: input.staffUserId, sellerId: ctx.sellerId } });
  if (!staff) throw notFound();
  if (staff.role === "OWNER") throw forbidden();
  const passwordHash = await hashPassword(input.newPassword);
  await db.$transaction(async (tx) => {
    await tx.sellerUser.update({ where: { id: staff.id }, data: { passwordHash } });
    const revoked = await tx.sellerSession.updateMany({ where: { sellerUserId: staff.id, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.staff.password_reset",
      targetType: "SellerUser",
      targetId: staff.id,
      after: { revokedSessions: revoked.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true };
}
