import type { IdentityVerification, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { keyedOwnerToken, parseAttemptKey, reuseKeyedAttempt, scopedAttemptKeyHash } from "../identity/attempt";
import type { IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { GRANT_TTL_MS } from "./passwordReset";
import { recoveryLimitReached } from "./recoveryLimit";
import { generateToken, hashToken } from "./token";

// 파트너스 아이디 찾기·계정 고르기 비밀번호 찾기(AU-011·AU-003, 2026-10-03 대표님 결정). 쇼핑몰을 몰라도 본인 휴대폰 본인확인으로 시작한다.
// 1) start: 본인확인 시작(같은 휴대폰 하루 10회·같은 IP 하루 30회, 비밀번호 찾기와 합산) → resend·confirm(공통 단계)
// 2) accounts: 본인확인 결과 CI와 맞는 계정 목록(쇼핑몰 이름·로그인 이메일). 대표자는 쇼핑몰 대표자 CI, 직원은 계정에 연결한 CI가 같아야 한다.
//    맞는 계정이 없으면 빈 목록(직원 미연결·번호 미등록 포함, 화면은 「대표자에게 물어봐 주세요」).
// 3) reset: 목록에서 고른 계정 하나에 비밀번호 재설정 권한(대표자 재설정과 같은 일회용·10분 권한, /api/seller/password-reset/complete로 저장)
// 본인확인은 시작한 브라우저(ownerToken)만 쓸 수 있고, 재설정 권한을 받으면 소진한다. 목록 보기는 확인 뒤 10분 안에 다시 볼 수 있다.

type Meta = { ip?: string | null; userAgent?: string | null; now?: Date; attemptKey?: unknown };
export type AccountType = "owner" | "staff";
const OWNER_SCOPE = "account_recovery_owner";

export type RecoveryStartResult =
  | { ok: true; verificationId: string; ownerToken: string }
  | { ok: false; reason: "recovery_limit_exceeded" | "invalid_identity_input" | "provider_error" | "start_in_progress" | "already_verified" | "expired" | "failed" };

export async function startAccountRecovery(db: PrismaClient, provider: IdentityProvider, rawPerson: unknown, meta: Meta = {}): Promise<RecoveryStartResult> {
  const attemptKey = parseAttemptKey(meta.attemptKey);
  if (attemptKey === false) return { ok: false, reason: "invalid_identity_input" };
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false, reason: "invalid_identity_input" };
  const ip = meta.ip ?? null;
  const keyHash = attemptKey ? scopedAttemptKeyHash("ACCOUNT_RECOVERY", "", attemptKey) : null;
  type Started =
    | null
    | { kind: "reused"; verificationId: string; ownerToken: string }
    | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "start_in_progress" }
    | { kind: "send"; verification: IdentityVerification; ownerToken: string };
  const started = await db.$transaction(async (tx): Promise<Started> => {
    const now = meta.now ?? (await dbNow(tx));
    if (keyHash) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`idv_key:${keyHash}`}))`;
      const same = await tx.identityVerification.findFirst({ where: { purpose: "ACCOUNT_RECOVERY", sellerId: null, attemptKeyHash: keyHash } });
      const r = await reuseKeyedAttempt(tx, same, now);
      if (r?.kind === "reused") return { ...r, ownerToken: keyedOwnerToken(OWNER_SCOPE, attemptKey!, r.verificationId) };
      if (r) return r;
    }
    if (await recoveryLimitReached(tx, person.phone, ip)) return null;
    const id = randomUUID();
    const created = await startIdentityVerification(tx, provider, {
      purpose: "ACCOUNT_RECOVERY",
      sellerId: null,
      person,
      requestIp: ip,
      attemptKeyHash: keyHash,
      sendStartedAt: keyHash ? now : null,
      id,
      ownerToken: attemptKey ? keyedOwnerToken(OWNER_SCOPE, attemptKey, id) : undefined,
      now: meta.now,
    });
    return { kind: "send", ...created };
  });
  if (started?.kind === "reused") return { ok: true, verificationId: started.verificationId, ownerToken: started.ownerToken };
  if (started?.kind === "refused") return { ok: false, reason: started.reason };
  if (!started) {
    await writeAudit(db, { actorType: "SYSTEM", action: "auth.seller.recovery.limited", reason: "recovery_limit_exceeded", ip, userAgent: meta.userAgent });
    return { ok: false, reason: "recovery_limit_exceeded" };
  }
  await writeAudit(db, {
    actorType: "SYSTEM",
    action: "auth.seller.recovery.start",
    targetType: "IdentityVerification",
    targetId: started.verification.id,
    ip,
    userAgent: meta.userAgent,
  });
  const sent = await sendFirstIdentityCode(db, provider, started.verification, person, meta.now);
  if (!sent.ok) return { ok: false, reason: sent.reason };
  return { ok: true, verificationId: started.verification.id, ownerToken: started.ownerToken };
}

export type RecoveryAccount = { accountId: string; shopName: string; shopSlug: string; email: string };

// 본인확인 결과 CI와 맞는 계정(활성 계정, 해지·반려된 쇼핑몰 제외). 대표자 탭은 쇼핑몰 대표자 CI가 같은 쇼핑몰의 대표자 계정,
// 직원 탭은 연결 CI가 같은 직원 계정. 쇼핑몰 이름·이메일 순.
async function matchingAccounts(db: PrismaClient, ciHash: string, accountType: AccountType) {
  const users = await db.sellerUser.findMany({
    where: {
      status: "ACTIVE",
      seller: { status: { notIn: ["CLOSED", "REJECTED"] }, ...(accountType === "owner" ? { representativeCiHash: ciHash } : {}) },
      ...(accountType === "owner" ? { isOwner: true } : { isOwner: false, identityCiHash: ciHash }),
    },
    select: { id: true, email: true, sellerId: true, seller: { select: { shopName: true, slug: true } } },
    orderBy: [{ seller: { shopName: "asc" } }, { email: "asc" }],
  });
  return users;
}

type Verified = { ok: true; verification: IdentityVerification } | { ok: false; reason: "pending" | "recovery_not_allowed" };

async function verified(db: PrismaClient, provider: IdentityProvider, verificationId: string, ownerToken: string | undefined, now: Date): Promise<Verified> {
  const done = await completeIdentityVerification(db, provider, verificationId, { sellerId: null, purpose: "ACCOUNT_RECOVERY", ownerToken }, now);
  if (!done.ok) return { ok: false, reason: done.reason === "pending" ? "pending" : "recovery_not_allowed" };
  if (done.verification.consumedAt || !done.verification.ciHash) return { ok: false, reason: "recovery_not_allowed" };
  return { ok: true, verification: done.verification };
}

// 아이디 찾기: 맞는 계정 목록. 본인확인을 소진하지 않는다(확인 뒤 10분 안에 비밀번호 재설정으로 이어 갈 수 있게).
export async function listRecoveryAccounts(
  db: PrismaClient,
  provider: IdentityProvider,
  input: { verificationId: string; ownerToken: string | undefined; accountType: AccountType },
  meta: Meta = {},
): Promise<{ ok: true; accounts: RecoveryAccount[] } | { ok: false; reason: "pending" | "recovery_not_allowed" }> {
  const now = meta.now ?? new Date();
  const v = await verified(db, provider, input.verificationId, input.ownerToken, now);
  if (!v.ok) return v;
  const users = await matchingAccounts(db, v.verification.ciHash!, input.accountType);
  await writeAudit(db, {
    actorType: "SYSTEM",
    action: "auth.seller.recovery.accounts",
    targetType: "IdentityVerification",
    targetId: v.verification.id,
    after: { accountType: input.accountType, count: users.length },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true, accounts: users.map((u) => ({ accountId: u.id, shopName: u.seller.shopName, shopSlug: u.seller.slug, email: u.email })) };
}

// 계정 고르기 비밀번호 찾기: 목록에서 고른 계정 하나에 재설정 권한. 고른 계정이 목록에 없으면(다른 사람 계정·종류 다름·연결 풀림) 거부.
// 본인확인은 권한을 줄 때 소진한다(같은 확인으로 두 계정을 바꾸지 못함).
export async function issueRecoveryResetGrant(
  db: PrismaClient,
  provider: IdentityProvider,
  input: { verificationId: string; ownerToken: string | undefined; accountType: AccountType; accountId: string },
  meta: Meta = {},
): Promise<{ ok: true; grantToken: string; expiresAt: Date } | { ok: false; reason: "pending" | "recovery_not_allowed" }> {
  const now = meta.now ?? new Date();
  const v = await verified(db, provider, input.verificationId, input.ownerToken, now);
  if (!v.ok) return v;
  const ciHash = v.verification.ciHash!;
  const user = (await matchingAccounts(db, ciHash, input.accountType)).find((u) => u.id === input.accountId);
  const fail = async (reason: string) => {
    await writeAudit(db, {
      actorType: "SYSTEM",
      action: "auth.seller.recovery.reset_failed",
      targetType: "IdentityVerification",
      targetId: v.verification.id,
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: false as const, reason: "recovery_not_allowed" as const };
  };
  if (!user) return fail("account_not_matched");
  const grantToken = generateToken();
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS);
  const issued = await db.$transaction(async (tx) => {
    const used = await tx.identityVerification.updateMany({ where: { id: v.verification.id, consumedAt: null }, data: { consumedAt: now, subjectId: user.id } });
    if (used.count !== 1) return false;
    await tx.passwordResetGrant.create({
      data: { sellerId: user.sellerId, sellerUserId: user.id, tokenHash: hashToken(grantToken), ciHash, expiresAt, createdAt: now },
    });
    await writeAudit(tx, {
      actorType: "SELLER_USER",
      actorId: user.id,
      sellerId: user.sellerId,
      action: "auth.seller.password_reset.granted",
      targetType: "SellerUser",
      targetId: user.id,
      after: { via: "account_recovery", accountType: input.accountType },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return true;
  });
  if (!issued) return fail("verification_already_used");
  return { ok: true, grantToken, expiresAt };
}
