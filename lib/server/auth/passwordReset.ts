import type { IdentityVerification, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { forbidden, notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { keyedOwnerToken, parseAttemptKey, reuseKeyedAttempt, scopedAttemptKeyHash } from "../identity/attempt";
import type { IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { hashPassword, verifyPassword } from "./password";
import { recoveryLimitReached } from "./recoveryLimit";
import { generateToken, hashToken } from "./token";
import { normalizeEmail } from "./login";

// 판매자 비밀번호 찾기: 대표자 휴대폰 본인확인으로만 한다(메일 링크 없음, 대표님 지시 2026-10-02).
// 1) 이메일+쇼핑몰로 시작 → 2) 휴대폰 본인확인 완료 후 CI가 쇼핑몰 대표자 CI와 같고 계정이 대표(OWNER)면 일회용·10분 재설정 권한 발급
// → 3) 새 비밀번호 저장, 그 계정의 기존 세션 모두 폐기. 계정이 있는지 없는지는 응답으로 드러나지 않는다.

export const GRANT_TTL_MS = 10 * 60_000;
// 새 비밀번호 저장에 성공한 뒤 응답을 잃은 재시도를 성공으로 돌려주는 시간(저장 시각부터)
export const RESET_COMPLETE_RETRY_MS = 10 * 60_000;

// 비밀번호 해시 함수(테스트에서 호출 여부를 확인할 수 있게 객체로 둔다)
export const passwordHasher = { hashPassword };

// 라우트 쿠키(시작한 브라우저 확인용·재설정 권한). 비밀번호 찾기 API 경로에서만 보낸다.
export const RESET_PATH = "/api/seller/password-reset";
export const IDV_COOKIE = "lo_idv";
export const GRANT_COOKIE = "lo_pwreset";
export const MIN_PASSWORD_LENGTH = 8;

type Meta = { ip?: string | null; userAgent?: string | null; now?: Date; attemptKey?: unknown };
const OWNER_SCOPE = "pwreset_owner";

// 쇼핑몰 하나당 하루(한국 시간 자정 초기화) 비밀번호 찾기 시작 횟수. 실제 휴대폰 본인확인은 호출마다 비용이 든다(대표님 결정 2026-10-02).
export const RESET_DAILY_LIMIT_PER_SHOP = 10;

export type StartResult =
  | { ok: true; verificationId: string; ownerToken: string }
  | { ok: false; reason: "reset_limit_exceeded" | "invalid_identity_input" | "provider_error" | "start_in_progress" | "already_verified" | "expired" | "failed" };

export async function startSellerPasswordReset(
  db: PrismaClient,
  provider: IdentityProvider,
  // accountType: 로그인 화면에서 고른 탭(owner|staff). 주면 그 종류의 계정만 대상으로 본다(다르면 없는 계정과 같은 처리).
  input: { email: string; shopSlug: string; person: unknown; accountType?: "owner" | "staff" },
  meta: Meta = {},
): Promise<StartResult> {
  const attemptKey = parseAttemptKey(meta.attemptKey);
  if (attemptKey === false) return { ok: false, reason: "invalid_identity_input" };
  const person = parseIdentityPerson(input.person);
  if (!person) return { ok: false, reason: "invalid_identity_input" };
  const seller = await db.seller.findUnique({ where: { slug: input.shopSlug }, select: { id: true } });
  const sellerId = seller?.id ?? null;
  const user = seller
    ? await db.sellerUser.findUnique({
        where: { sellerId_email: { sellerId: seller.id, email: normalizeEmail(input.email) } },
        select: { id: true, isOwner: true },
      })
    : null;
  const subject = user && (!input.accountType || user.isOwner === (input.accountType === "owner")) ? user : null;
  const ip = meta.ip ?? null;

  // attemptKey(선택, 클라이언트 UUID): 응답이 끊겨 같은 키로 다시 보내면 같은 기록·같은 ownerToken을 돌려주고 문자·하루 횟수를 다시 쓰지 않는다.
  // 키는 같은 쇼핑몰 주소·같은 아이디 범위로만 찾는다(다른 아이디로 같은 키를 보내면 새 시작). 계정 유무와 상관없이 같은 응답이다.
  const keyHash = attemptKey ? scopedAttemptKeyHash("PASSWORD_RESET", `${sellerId ?? `none:${input.shopSlug}`}\0${normalizeEmail(input.email)}`, attemptKey) : null;
  type Started =
    | null
    | { kind: "reused"; verificationId: string; ownerToken: string }
    | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "start_in_progress" }
    | { kind: "send"; verification: IdentityVerification; ownerToken: string };
  // 쇼핑몰별로 줄을 세워(advisory lock) 오늘(KST) 시작 건수를 DB 시계로 센 뒤, 한도 안일 때만 인증을 시작한다.
  // 없는 쇼핑몰 주소로 온 요청은 하나의 묶음(sellerId 없음)으로 센다. 계정 유무와 상관없이 같은 응답이다.
  const started = await db.$transaction(async (tx): Promise<Started> => {
    if (keyHash) {
      const now = meta.now ?? (await dbNow(tx));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`idv_key:${keyHash}`}))`;
      const same = await tx.identityVerification.findFirst({ where: { purpose: "PASSWORD_RESET", sellerId, attemptKeyHash: keyHash } });
      const r = await reuseKeyedAttempt(tx, same, now);
      if (r?.kind === "reused") return { ...r, ownerToken: keyedOwnerToken(OWNER_SCOPE, attemptKey!, r.verificationId) };
      if (r) return r;
    }
    // 같은 휴대폰 하루 10회·같은 IP 하루 30회(아이디 찾기와 합산, auth/recoveryLimit.ts) → 쇼핑몰당 하루 10회
    if (await recoveryLimitReached(tx, person.phone, ip)) return null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pwreset:${sellerId ?? "none"}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'PASSWORD_RESET'
        AND "sellerId" IS NOT DISTINCT FROM ${sellerId}::uuid
        AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= RESET_DAILY_LIMIT_PER_SHOP) return null;
    const id = randomUUID();
    const created = await startIdentityVerification(tx, provider, {
      purpose: "PASSWORD_RESET",
      sellerId,
      person,
      subjectId: subject?.id ?? null,
      requestIp: ip,
      attemptKeyHash: keyHash,
      sendStartedAt: keyHash ? (meta.now ?? (await dbNow(tx))) : null,
      id,
      ownerToken: attemptKey ? keyedOwnerToken(OWNER_SCOPE, attemptKey, id) : undefined,
      now: meta.now,
    });
    return { kind: "send", ...created };
  });
  if (started?.kind === "reused") return { ok: true, verificationId: started.verificationId, ownerToken: started.ownerToken };
  if (started?.kind === "refused") return { ok: false, reason: started.reason };

  if (!started) {
    await writeAudit(db, {
      actorType: "SELLER_USER",
      actorId: user?.id ?? null,
      sellerId,
      action: "auth.seller.password_reset.limited",
      reason: "reset_limit_exceeded",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: false, reason: "reset_limit_exceeded" };
  }
  const { verification, ownerToken } = started;
  await writeAudit(db, {
    actorType: "SELLER_USER",
    actorId: user?.id ?? null,
    sellerId,
    action: "auth.seller.password_reset.start",
    targetType: "IdentityVerification",
    targetId: verification.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const sent = await sendFirstIdentityCode(db, provider, verification, person, meta.now);
  if (!sent.ok) return { ok: false, reason: sent.reason };
  return { ok: true, verificationId: verification.id, ownerToken };
}

export type GrantResult = { ok: true; grantToken: string; expiresAt: Date } | { ok: false; reason: "reset_not_allowed" | "pending" };

// 휴대폰 본인확인 완료 확인 → CI 비교 → 재설정 권한 발급. 대표자는 쇼핑몰 대표자 CI, 직원은 계정에 연결한 CI와 같아야 한다
// (2026-10-03 대표님 결정, 연결 안 된 직원은 대표자 재설정만). 실패 사유는 하나로 묶는다(계정 존재·종류·CI 일치·연결 여부 비노출).
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
  // 거부되는 경우에도 이 본인인증은 소진해 같은 인증으로 다시 시도하지 못하게 한다.
  const rejectAndConsume = async (reason: string): Promise<GrantResult> => {
    await db.identityVerification.updateMany({ where: { id: v.id, consumedAt: null }, data: { consumedAt: now } });
    await failAudit(reason);
    return { ok: false, reason: "reset_not_allowed" };
  };
  if (!user || user.sellerId !== v.sellerId) return rejectAndConsume("account_not_found");
  if (user.status !== "ACTIVE") return rejectAndConsume("account_disabled");
  const expected = expectedResetCi(user);
  if (!expected) return rejectAndConsume(user.isOwner ? "ci_mismatch" : "staff_not_linked");
  if (!ci || expected !== ci) return rejectAndConsume("ci_mismatch");

  const grantToken = generateToken();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS);
  const issued = await db.$transaction(async (tx) => {
    // 같은 본인인증으로 재설정 권한을 두 번 받지 못한다.
    const used = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null }, data: { consumedAt: now } });
    if (used.count !== 1) return false;
    await tx.passwordResetGrant.create({
      data: { sellerId: user.sellerId, sellerUserId: user.id, tokenHash: hashToken(grantToken), ciHash: ci, expiresAt, createdAt: now },
    });
    // 발급 기록도 같은 트랜잭션에서 남긴다(쓰지 못하면 권한 발급·본인확인 소진도 되돌린다)
    await writeAudit(tx, {
      actorType: "SELLER_USER",
      actorId: user.id,
      sellerId: user.sellerId,
      action: "auth.seller.password_reset.granted",
      targetType: "SellerUser",
      targetId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return true;
  });
  if (!issued) {
    await failAudit("verification_already_used");
    return { ok: false, reason: "reset_not_allowed" };
  }
  return { ok: true, grantToken, expiresAt };
}

// 재설정 권한을 줄 때·쓸 때 대조하는 CI 해시: 대표자는 쇼핑몰 대표자 CI, 직원은 연결 CI(없으면 null = 셀프 재설정 불가)
export function expectedResetCi(u: { isOwner: boolean; identityCiHash: string | null; seller: { representativeCiHash: string | null } }): string | null {
  return u.isOwner ? u.seller.representativeCiHash : u.identityCiHash;
}

export type ResetResult = { ok: true } | { ok: false; reason: "invalid_grant" | "weak_password" };

// 재설정 권한으로 새 비밀번호 저장. 권한은 한 번만 쓰이고, 그 계정의 기존 세션은 모두 폐기한다.
// 멱등(MASTER 지시): 이 권한으로 이미 저장에 성공했고(completedAt) 같은 새 비밀번호로 다시 보내면 성공을 돌려준다(응답 유실 대비).
// 이때는 아무것도 바꾸지 않는다(세션 폐기·감사 기록은 처음 한 번만). 다른 비밀번호거나 재시도 시간이 지났으면 invalid_grant.
export async function resetSellerPassword(
  db: PrismaClient,
  input: { grantToken: string | undefined; newPassword: string },
  meta: Meta = {},
): Promise<ResetResult> {
  const now = meta.now ?? new Date();
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  if (!input.grantToken) return { ok: false, reason: "invalid_grant" };
  const tokenHash = hashToken(input.grantToken);
  // 무효한 권한이면 비싼 해시 계산 전에 거부한다. 실제 소진은 아래 트랜잭션에서 원자적으로 한다.
  const candidate = await db.passwordResetGrant.findUnique({ where: { tokenHash }, select: { usedAt: true, expiresAt: true } });
  if (candidate?.usedAt) return (await alreadyCompleted(db, tokenHash, input.newPassword, now)) ? { ok: true } : { ok: false, reason: "invalid_grant" };
  if (!candidate || candidate.expiresAt <= now) return { ok: false, reason: "invalid_grant" };
  const passwordHash = await passwordHasher.hashPassword(input.newPassword);

  // 권한을 먼저 소진하고(한 번만 쓰임), 그 순간 계정·대표자 CI를 다시 확인한다. 확인에 실패해도 권한은 소진된 채로 남는다.
  const outcome = await db.$transaction(async (tx) => {
    const used = await tx.passwordResetGrant.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) return { grant: null, reason: "lost_race" as const };
    const g = await tx.passwordResetGrant.findUniqueOrThrow({
      where: { tokenHash },
      include: { sellerUser: { include: { seller: { select: { representativeCiHash: true } } } } },
    });
    const u = g.sellerUser;
    // 발급 뒤 계정이 비활성화됐거나, 대조한 CI(대표자 CI·직원 연결 CI)가 바뀌었거나 대표자·직원 종류가 바뀌었으면 거부
    const expected = expectedResetCi(u);
    const stale = u.status !== "ACTIVE" ? "account_disabled" : !expected ? (u.isOwner ? "ci_changed" : "staff_not_linked") : expected !== g.ciHash ? "ci_changed" : null;
    if (stale) return { grant: g, reason: stale };

    await tx.sellerUser.update({ where: { id: g.sellerUserId }, data: { passwordHash, credentialVersion: { increment: 1 } } });
    await tx.passwordResetGrant.update({ where: { id: g.id }, data: { completedAt: now } });
    const revoked = await tx.sellerSession.updateMany({ where: { sellerUserId: g.sellerUserId, revokedAt: null }, data: { revokedAt: now } });
    // 같은 계정의 다른 미사용 재설정 권한은 모두 무효
    const otherGrants = await tx.passwordResetGrant.updateMany({
      where: { sellerUserId: g.sellerUserId, usedAt: null, id: { not: g.id } },
      data: { usedAt: now },
    });
    await writeAudit(tx, {
      actorType: "SELLER_USER",
      actorId: g.sellerUserId,
      sellerId: g.sellerId,
      action: "auth.seller.password_reset.completed",
      targetType: "SellerUser",
      targetId: g.sellerUserId,
      after: { revokedSessions: revoked.count, revokedGrants: otherGrants.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { grant: g, reason: null };
  });
  // 같은 권한으로 동시에 보낸 요청: 앞 요청이 커밋한 뒤 0행으로 끝나므로, 다시 읽어 같은 비밀번호로 저장됐으면 성공으로 돌려준다
  if (outcome.reason === "lost_race") {
    if (await alreadyCompleted(db, tokenHash, input.newPassword, now)) return { ok: true };
    return failed(db, null, "invalid_grant", meta);
  }
  if (outcome.reason !== null) return failed(db, outcome.grant, outcome.reason, meta);
  return { ok: true };
}

// 이 권한으로 저장에 성공했고(completedAt, 재시도 시간 안), 계정이 아직 활성이며 지금 비밀번호가 보낸 새 비밀번호와 같은지
async function alreadyCompleted(db: PrismaClient, tokenHash: string, newPassword: string, now: Date): Promise<boolean> {
  const g = await db.passwordResetGrant.findUnique({ where: { tokenHash }, select: { completedAt: true, sellerUser: { select: { status: true, passwordHash: true } } } });
  if (!g?.completedAt || now.getTime() - g.completedAt.getTime() > RESET_COMPLETE_RETRY_MS || g.sellerUser.status !== "ACTIVE") return false;
  return verifyPassword(g.sellerUser.passwordHash, newPassword);
}

// 저장 실패 감사 기록(권한을 소진했지만 계정·CI 확인에 실패했거나, 권한이 이미 쓰였거나 없음)
async function failed(db: PrismaClient, grant: { sellerUserId: string; sellerId: string } | null, reason: string, meta: Meta): Promise<ResetResult> {
  await writeAudit(db, {
    actorType: "SELLER_USER",
    actorId: grant?.sellerUserId ?? null,
    sellerId: grant?.sellerId ?? null,
    action: "auth.seller.password_reset.failed",
    reason,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: false, reason: "invalid_grant" };
}

// 직원(매니저·방송 담당) 비밀번호는 대표가 직원 관리에서 재설정한다. 같은 쇼핑몰 직원만, 대표 계정은 대상이 아니다.
export async function resetStaffPassword(
  db: PrismaClient,
  ctx: TenantContext,
  input: { staffUserId: string; newPassword: string },
  meta: Meta = {},
): Promise<ResetResult> {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  const now = meta.now ?? new Date();
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  const staff = await db.sellerUser.findFirst({ where: { id: input.staffUserId, sellerId: ctx.sellerId } });
  if (!staff) throw notFound();
  if (staff.isOwner) throw forbidden();
  const passwordHash = await hashPassword(input.newPassword);
  await db.$transaction(async (tx) => {
    await tx.sellerUser.update({ where: { id: staff.id }, data: { passwordHash, credentialVersion: { increment: 1 } } });
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
