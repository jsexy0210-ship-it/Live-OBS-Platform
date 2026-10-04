import type { IdentityVerification, Prisma, PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { keyedOwnerToken, parseAttemptKey, reuseKeyedAttempt, scopedAttemptKeyHash } from "../identity/attempt";
import type { IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { GRANT_TTL_MS, grantTokenOf } from "./passwordReset";
import { recoveryLimitReached } from "./recoveryLimit";
import { hashToken } from "./token";

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

// 권한 응답을 잃은 재시도를 받아 주는 시간(본인확인을 소진한 뒤)
export const RECOVERY_RESET_RETRY_MS = 10 * 60_000;

// 계정 고르기 비밀번호 찾기: 목록에서 고른 계정 하나에 재설정 권한. 고른 계정이 목록에 없으면(다른 사람 계정·종류 다름·연결 풀림) 거부.
// 본인확인은 권한을 줄 때 소진한다(같은 확인으로 두 계정을 바꾸지 못함).
// 응답을 잃은 재시도: 시작한 브라우저(쿠키)가 같은 본인확인·같은 계정으로 소진 뒤 10분 안에 다시 요청하면 그 본인확인으로 준 권한의
// 같은 토큰을 다시 만들어 돌려준다(권한 행의 nonce로 재생성, 원문은 저장하지 않음). 그래서 동시에 겹친 재시도도 같은 토큰을 받고,
// 다른 복구 흐름의 권한은 건드리지 않는다. 그 권한을 이미 썼거나, 다른 계정·기간이 지난 요청은 거부한다.
export async function issueRecoveryResetGrant(
  db: PrismaClient,
  provider: IdentityProvider,
  input: { verificationId: string; ownerToken: string | undefined; accountType: AccountType; accountId: string },
  meta: Meta = {},
): Promise<{ ok: true; grantToken: string; expiresAt: Date } | { ok: false; reason: "pending" | "recovery_not_allowed" }> {
  const now = meta.now ?? new Date();
  const done = await completeIdentityVerification(db, provider, input.verificationId, { sellerId: null, purpose: "ACCOUNT_RECOVERY", ownerToken: input.ownerToken }, now);
  let v: IdentityVerification | null = done.ok ? done.verification : null;
  if (!done.ok) {
    if (done.reason === "pending") return { ok: false, reason: "pending" };
    // 소진 뒤 본인확인 유효 시간이 지난 재시도도 같은 브라우저의 것이면 아래 재시도 판정으로 넘긴다
    const row = done.reason === "expired" ? await db.identityVerification.findUnique({ where: { id: input.verificationId } }) : null;
    const owned = !!row && row.purpose === "ACCOUNT_RECOVERY" && row.sellerId === null && row.status === "VERIFIED" && !!input.ownerToken && row.ownerTokenHash === hashToken(input.ownerToken);
    if (!owned || !row.consumedAt) return { ok: false, reason: "recovery_not_allowed" };
    v = row;
  }
  if (!v?.ciHash) return { ok: false, reason: "recovery_not_allowed" };
  const verification = v;
  const ciHash = v.ciHash;
  const fail = async (reason: string) => {
    await writeAudit(db, {
      actorType: "SYSTEM",
      action: "auth.seller.recovery.reset_failed",
      targetType: "IdentityVerification",
      targetId: verification.id,
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: false as const, reason: "recovery_not_allowed" as const };
  };
  const user = (await matchingAccounts(db, ciHash, input.accountType)).find((u) => u.id === input.accountId);
  if (!user) return fail("account_not_matched");
  const issued = await db.$transaction(async (tx): Promise<{ grantToken: string; expiresAt: Date } | string | null> => {
    // 같은 본인확인의 권한 발급을 한 줄로 세운다(처음 발급·재시도가 겹쳐도 하나씩, 늦은 쪽은 먼저 만든 권한을 다시 받음)
    const [cur] = await tx.$queryRaw<{ consumedAt: Date | null; subjectId: string | null }[]>`
      SELECT "consumedAt", "subjectId" FROM "IdentityVerification" WHERE "id" = ${verification.id}::uuid FOR UPDATE`;
    if (!cur) return null;
    if (cur.consumedAt) {
      if (cur.subjectId !== user.id) return "account_not_matched";
      if (now.getTime() - cur.consumedAt.getTime() > RECOVERY_RESET_RETRY_MS) return "retry_window_passed";
      const [prior] = await tx.$queryRaw<{ nonce: string | null; usedAt: Date | null; expiresAt: Date }[]>`
        SELECT "nonce", "usedAt", "expiresAt" FROM "PasswordResetGrant"
        WHERE "verificationId" = ${verification.id}::uuid AND "sellerUserId" = ${user.id}::uuid
        ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`;
      if (!prior?.nonce) return "verification_already_used";
      if (prior.usedAt) return "grant_already_used";
      if (prior.expiresAt <= now) return "retry_window_passed";
      return { grantToken: grantTokenOf(prior.nonce), expiresAt: prior.expiresAt };
    }
    if (!done.ok) return null;
    await tx.identityVerification.update({ where: { id: verification.id }, data: { consumedAt: now, subjectId: user.id } });
    const nonce = randomBytes(32).toString("base64url");
    const grantToken = grantTokenOf(nonce);
    const expiresAt = new Date(now.getTime() + GRANT_TTL_MS);
    await tx.passwordResetGrant.create({
      data: { sellerId: user.sellerId, sellerUserId: user.id, tokenHash: hashToken(grantToken), ciHash, expiresAt, createdAt: now, verificationId: verification.id, nonce },
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
    return { grantToken, expiresAt };
  });
  if (!issued || typeof issued === "string") return fail(issued ?? "verification_already_used");
  return { ok: true, ...issued };
}

// 아이디 찾기(ACCOUNT_RECOVERY)·직원 연결(STAFF_LINK) 본인확인 기록 비식별(MASTER 2026-10-04, 가입 기록과 같은 기준).
// 하루 횟수를 세는 기간(그 기록의 KST 날짜)이 지나고 유효 시간·권한 재시도 기간(10분)도 지난 기록의 이름·휴대폰·요청 휴대폰·생년월일·
// CI 해시·subjectId·시작 브라우저 값(ownerTokenHash)·요청 IP를 비우고, 대행사 조회 열쇠인 requestId는 겹치지 않는 무작위 값으로 바꾼다.
// 행·용도·상태·요청 시각은 남긴다. 오늘 기록은 건드리지 않으므로 휴대폰·IP·직원별 하루 횟수 계산은 그대로다.
// 연결된 직원의 CI 해시는 SellerUser.identityCiHash에 있으므로 그대로 둔다. 정기 실행(jobs/scheduler.ts)이 부른다. 비식별한 수를 돌려준다.
export async function purgeOldRecoveryVerifications(db: PrismaClient | Prisma.TransactionClient, now?: Date): Promise<number> {
  const at = now ?? (await dbNow(db));
  return db.$executeRaw`
    UPDATE "IdentityVerification"
    SET "name" = NULL, "phone" = NULL, "requestedPhone" = NULL, "birthDate" = NULL, "ciHash" = NULL, "subjectId" = NULL,
        "ownerTokenHash" = NULL, "requestIp" = NULL, "requestId" = 'anonymized:' || gen_random_uuid()::text, "anonymizedAt" = ${at}
    WHERE "purpose" IN ('ACCOUNT_RECOVERY', 'STAFF_LINK') AND "anonymizedAt" IS NULL
      AND "createdAt" < (date_trunc('day', ${at}::timestamptz AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')
      AND "expiresAt" + make_interval(secs => ${RECOVERY_RESET_RETRY_MS / 1000}::int) <= ${at}`;
}
