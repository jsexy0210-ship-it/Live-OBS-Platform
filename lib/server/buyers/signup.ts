import { Prisma, type IdentityVerification, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { hashPassword, verifyPassword } from "../auth/password";
import { MAX_EMAIL_LENGTH, normalizeEmail } from "../auth/login";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { dbNow, sellerAccessFor } from "../billing/subscription";
import type { IdentityProvider } from "../identity/provider";
import { createHash, randomUUID } from "node:crypto";
import { hashToken } from "../auth/token";
import { buyerSignupIdentityLimitReached, completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { EMAIL } from "../sellers/application";
import { REJOIN_RETENTION_CONSENT_VERSION, purgeExpiredRejoinBlocks, rejoinBlockedUntil, rejoinDaysToAgree } from "./rejoin";
import { cleanText } from "../text/clean";


// 본인인증 후 가입에 쓸 수 있는 시간
const SIGNUP_WINDOW_MS = 30 * 60_000;

// 구매자 가입 흐름의 쿠키(휴대폰 본인확인을 시작한 브라우저 확인용). 그 쇼핑몰 가입 경로에서만 보낸다.
export const BUYER_SIGNUP_IDV_COOKIE = "lo_bidv";
export const buyerSignupPath = (slug: string) => `/api/shop/${slug}/signup`;
// 같은 IP에서 하루(KST)에 시작할 수 있는 구매자 가입 본인확인 수(쇼핑몰마다). 판매자 가입과 같은 10회.
export const BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP = 10;

// 가입 입력 규칙: 아이디는 이메일(PRODUCT_SCOPE 「아이디(이메일)」, 254자까지, 소문자로 맞춰 저장해 대소문자만 다른 중복을 막는다),
// 비밀번호 8~200자, 방송 닉네임 1~20자(보이는 글자).
export const MAX_NICKNAME_LENGTH = 20;

// 본인확인 1건으로 가입을 시도할 수 있는 횟수(아이디·닉네임 중복 실패 포함). 같은 본인확인으로 다른 사람의 가입 여부를
// 계속 조회하지 못하게 한다(#114 보안 검수). 입력 형식 오류(400)는 DB를 보기 전에 끝나므로 세지 않는다.
export const MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION = 5;

// 운영 중이고 잠기지 않은 쇼핑몰만 가입을 받는다(주문과 같은 기준, DB 시계)
export async function shopOpen(db: PrismaClient, sellerId: string) {
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
  return !!seller && seller.status === "ACTIVE" && (await sellerAccessFor(db, sellerId)) !== "expired";
}

// 첫 문자를 보내는 중으로 보는 시간. 공급자 호출 제한시간(10초)보다 넉넉하게 잡는다. 이 시간이 지나도 보낸 기록이 없으면
// 앞 요청이 멈춘 것으로 보고 같은 키 재요청이 그 기록을 버리고 새로 시작한다.
export const FIRST_SEND_WINDOW_MS = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// attemptKey로 시작한 기록의 ownerToken은 키와 기록 id로 정해진다. 같은 키 재요청이 몇 번 겹쳐도 모두 같은 토큰을 받으므로
// 응답이 어떤 순서로 도착해도 브라우저 쿠키가 무효가 되지 않는다. 키를 가진 쪽만 만들 수 있고(키는 브라우저만 안다),
// DB에는 키·토큰 모두 해시만 있다.
function keyedOwnerToken(attemptKey: string, verificationId: string) {
  return createHash("sha256").update(`buyer_signup_owner\0${attemptKey.toLowerCase()}\0${verificationId}`).digest("base64url");
}

// 구매자 가입 1단계: 휴대폰 본인확인 시작(같은 IP·같은 쇼핑몰 하루 10회까지). 첫 인증번호를 보내고 ownerToken을 돌려준다.
// 기록 생성은 짧은 트랜잭션에서 커밋하고(sendStartedAt 기록), 첫 문자는 트랜잭션 밖에서 보낸다. 공급자를 기다리는 동안
// 잠금·DB 연결을 쥐지 않는다. 보내면 sendCount 0→1, 실패하면 FAILED로 바꾸고 attemptKey를 비워 같은 키로 다시 시작할 수 있게 한다.
// attemptKey(선택, 클라이언트가 만든 UUID): 응답이 끊겨 같은 키로 다시 보내면 키별 잠금 아래에서 같은 쇼핑몰·같은 키의 기록을 찾는다.
// - 확인 전(PENDING)이고 첫 문자를 보냈으면 그대로 쓰고 같은 ownerToken을 다시 준다(토큰을 바꾸지 않음). 일일 횟수·체험 한도는 다시 세지 않는다.
// - 아직 보내는 중이면(FIRST_SEND_WINDOW_MS 안) 기다리지 않고 start_in_progress로 돌려준다.
// - 보내는 중으로 둔 채 그 시간이 지났으면(앞 요청이 멈춤) 공급자가 문자를 받았는지 알 수 없어 같은 요청 id로 다시 보내지 않는다.
//   그 기록을 FAILED로 버리고(키 비움) 새 기록·새 요청 id로 처음부터 시작한다(일일 횟수에 1회 더 들어감).
// - 확인 전이 아니면(확인됨·만료·실패) 그 상태의 오류를 돌려준다.
export async function startBuyerSignupVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  sellerId: string,
  rawPerson: unknown,
  meta: { ip?: string | null; userAgent?: string | null; now?: Date; attemptKey?: unknown } = {},
) {
  if (!(await shopOpen(db, sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  if (meta.attemptKey !== undefined && (typeof meta.attemptKey !== "string" || !UUID_RE.test(meta.attemptKey))) {
    return { ok: false as const, reason: "invalid_identity_input" as const };
  }
  const attemptKey = typeof meta.attemptKey === "string" ? meta.attemptKey.toLowerCase() : null;
  const keyHash = attemptKey ? hashToken(attemptKey) : null;
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false as const, reason: "invalid_identity_input" as const };
  const ip = meta.ip ?? null;
  type Started =
    | { kind: "reused"; verificationId: string; ownerToken: string }
    | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "trial_limit_exceeded" | "start_in_progress" }
    | { kind: "limited" }
    | { kind: "send"; verification: IdentityVerification; ownerToken: string };
  const started = await db.$transaction(async (tx): Promise<Started> => {
    const now = meta.now ?? (await dbNow(tx));
    if (keyHash) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_signup_key:${sellerId}:${keyHash}`}))`;
      const same = await tx.identityVerification.findUnique({ where: { sellerId_attemptKeyHash: { sellerId, attemptKeyHash: keyHash } } });
      if (same) {
        if (same.status === "PENDING" && same.expiresAt > now) {
          if (same.sendCount > 0) return { kind: "reused", verificationId: same.id, ownerToken: keyedOwnerToken(attemptKey!, same.id) };
          if (same.sendStartedAt && now.getTime() - same.sendStartedAt.getTime() < FIRST_SEND_WINDOW_MS) return { kind: "refused", reason: "start_in_progress" };
          // 앞 요청이 멈췄다. 보낸 시작 시각이 그대로일 때만 버린다(compare-and-set). 늦게 끝난 앞 요청은 실패로 돌려받는다.
          const dropped = await tx.identityVerification.updateMany({
            where: { id: same.id, status: "PENDING", sendCount: 0, sendStartedAt: same.sendStartedAt },
            data: { status: "FAILED", attemptKeyHash: null },
          });
          if (dropped.count !== 1) return { kind: "refused", reason: "start_in_progress" };
        } else {
          if (same.status === "VERIFIED") return { kind: "refused", reason: "already_verified" };
          if (same.status === "FAILED") return { kind: "refused", reason: "failed" };
          return { kind: "refused", reason: "expired" };
        }
      }
    }
    // 체험하기 중 본인확인 한도가 찼으면 확정할 수 없으니 기록을 만들거나 문자를 보내지 않는다
    if (await buyerSignupIdentityLimitReached(tx, sellerId, meta.now)) return { kind: "refused", reason: "trial_limit_exceeded" };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_signup:${sellerId}:${ip ?? "unknown"}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'BUYER_SIGNUP' AND "sellerId" = ${sellerId}::uuid
        AND "requestIp" IS NOT DISTINCT FROM ${ip}
        AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP) return { kind: "limited" };
    const id = randomUUID();
    const created = await startIdentityVerification(tx, provider, {
      purpose: "BUYER_SIGNUP",
      sellerId,
      person,
      requestIp: ip,
      attemptKeyHash: keyHash,
      sendStartedAt: now,
      id,
      ownerToken: attemptKey ? keyedOwnerToken(attemptKey, id) : undefined,
      now: meta.now,
    });
    return { kind: "send", verification: created.verification, ownerToken: created.ownerToken };
  });
  if (started.kind === "reused") return { ok: true as const, verificationId: started.verificationId, ownerToken: started.ownerToken };
  if (started.kind === "refused") return { ok: false as const, reason: started.reason };
  if (started.kind === "limited") {
    await writeAudit(db, { actorType: "SYSTEM", sellerId, action: "buyer.signup.verify_limited", reason: "daily_limit_exceeded", ip, userAgent: meta.userAgent });
    return { ok: false as const, reason: "daily_limit_exceeded" as const };
  }
  const sent = await sendFirstIdentityCode(db, provider, started.verification, person, meta.now);
  if (!sent.ok) return { ok: false as const, reason: sent.reason };
  return { ok: true as const, verificationId: started.verification.id, ownerToken: started.ownerToken };
}

export type BuyerSignupFailure =
  | "invalid_login_id"
  | "weak_password"
  | "invalid_nickname"
  | "terms_required"
  | "invalid_marketing_consent" // 마케팅 수신 동의 값이 불리언이 아님
  | "verification_pending"
  | "verification_invalid"
  | "too_many_signup_attempts"
  | "already_member"
  | "login_id_taken"
  | "nickname_taken"
  | "shop_unavailable"
  | "rejoin_restricted" // 재가입 제한 기간 중(탈퇴한 같은 사람, buyers/rejoin.ts)
  | "invalid_rejoin_consent" // 재가입 제한 정보 보관 동의 값이 불리언이 아님
  | "rejoin_policy_changed" // 동의한 회원: 화면에 보여 준 재가입 제한 기간이 지금 정책과 다름(화면을 다시 불러와 다시 동의)
  | "consent_outdated"; // 동의한 회원: 화면이 보여 준 재가입 제한 정보 보관 동의 문서 버전이 지금과 다름

// resumed: 응답이 끊겨 같은 요청을 다시 보낸 경우(새로 만들지 않고 이미 만든 회원을 돌려줌)
// rejoinAvailableAt: rejoin_restricted일 때 다시 가입할 수 있는 시각
export type BuyerSignupResult =
  | { ok: true; memberId: string; broadcastNickname: string; resumed: boolean }
  | { ok: false; reason: BuyerSignupFailure; rejoinAvailableAt?: Date };

// 구매자 회원가입. 휴대폰 본인확인(같은 쇼핑몰, 같은 공급자, 완료, 사용 기한·30분 안, 시작한 브라우저의 ownerToken,
// 아직 안 쓴 건)이 있어야 하고, 같은 쇼핑몰에 같은 CI로 가입한 회원이 있으면 거부한다. 이름·휴대폰·생년월일은 인증 결과를 쓴다.
// 본인확인은 completeIdentityVerification으로 확인한다(공급자·용도·쇼핑몰·ownerToken이 모두 맞아야 한다).
// 필수 약관(이용약관·개인정보 수집·이용) 동의가 있어야 하고, 동의는 감사 로그에 남긴다.
export async function signupBuyer(
  db: PrismaClient,
  provider: IdentityProvider,
  input: {
    sellerId: string;
    verificationId: string;
    ownerToken: string | undefined;
    loginId: string;
    password: string;
    broadcastNickname: string;
    // 필수 약관 동의(true여야 한다). 생략하면 동의한 것으로 보지 않는다.
    agreedTerms?: boolean;
    agreedPrivacy?: boolean;
    // 선택 마케팅 수신 동의. true면 가입 시각을 marketingConsentAt에 남긴다. 빠지면 동의 안 함, 불리언이 아니면 거부.
    agreedMarketing?: unknown;
    // 「재가입 제한 정보 보관 동의」(선택, 대표님 결정 2026-10-03). 재가입 제한을 켠 쇼핑몰에서만 보고, 빠지면 동의 안 함, 불리언이 아니면 거부.
    // 동의하지 않은 회원은 기간 스냅숏이 없어 탈퇴 때 CI 해시를 남기지 않고 재가입 제한도 받지 않는다.
    agreedRejoinRetention?: unknown;
    // 동의한 경우: 화면이 보여 준 재가입 제한 기간(일)과 동의 문서 버전. 지금 정책·버전과 다르면 동의한 내용을 확인할 수 없어
    // 저장하지 않는다(409 rejoin_policy_changed·consent_outdated).
    rejoinRestrictionDaysShown?: unknown;
    rejoinRetentionVersionShown?: unknown;
    // 감사 로그에 남길 요청 정보
    meta?: { ip?: string | null; userAgent?: string | null };
    now?: Date;
  },
): Promise<BuyerSignupResult> {
  const now = input.now ?? new Date();
  if (!(await shopOpen(db, input.sellerId))) return { ok: false, reason: "shop_unavailable" };
  const loginId = typeof input.loginId === "string" ? normalizeEmail(input.loginId) : "";
  if (loginId.length > MAX_EMAIL_LENGTH || !EMAIL.test(loginId)) return { ok: false, reason: "invalid_login_id" };
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 200) return { ok: false, reason: "weak_password" };
  const nickname = cleanText(input.broadcastNickname, MAX_NICKNAME_LENGTH);
  if (!nickname) return { ok: false, reason: "invalid_nickname" };
  if (input.agreedTerms !== true || input.agreedPrivacy !== true) return { ok: false, reason: "terms_required" };
  if (input.agreedMarketing !== undefined && typeof input.agreedMarketing !== "boolean") return { ok: false, reason: "invalid_marketing_consent" };
  const agreedMarketing = input.agreedMarketing === true;
  if (input.agreedRejoinRetention !== undefined && typeof input.agreedRejoinRetention !== "boolean") return { ok: false, reason: "invalid_rejoin_consent" };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.verificationId)) return { ok: false, reason: "verification_invalid" };

  const done = await completeIdentityVerification(db, provider, input.verificationId, { sellerId: input.sellerId, purpose: "BUYER_SIGNUP", ownerToken: input.ownerToken }, now);
  if (!done.ok) return { ok: false, reason: done.reason === "pending" ? "verification_pending" : "verification_invalid" };
  const v = done.verification;
  // 응답 유실 뒤 다시 보낸 요청: 이 본인확인으로 이미 만든 회원(subjectId)이고 아이디·비밀번호가 같으면 그 회원을 돌려준다.
  // 시작한 브라우저(ownerToken)만 여기까지 온다. 시도 횟수에 넣지 않고, 아니면 지금처럼 verification_invalid.
  const resume = async (subjectId: string | null): Promise<BuyerSignupResult> => {
    const made = subjectId ? await db.buyerMember.findFirst({ where: { id: subjectId, sellerId: input.sellerId, status: "ACTIVE", deletedAt: null } }) : null;
    if (made && made.loginId === loginId && (await verifyPassword(made.passwordHash, input.password))) {
      return { ok: true, memberId: made.id, broadcastNickname: made.broadcastNickname, resumed: true };
    }
    return { ok: false, reason: "verification_invalid" };
  };
  // 이미 가입을 마친 같은 요청의 재시도는 정책 대조보다 먼저 본다(그사이 정책이 바뀌어도 만든 계정의 201·세션을 받는다)
  if (v.consumedAt) return resume(v.subjectId);
  // 재가입 제한을 켠 쇼핑몰에서 보관에 동의한 경우만 기간을 회원에 남긴다(가입 처리 중 설정이 바뀌어도 동의한 값 기준).
  // 화면을 연 뒤 판매자가 기간을 바꿨거나 문서 버전이 바뀌었으면 동의한 내용과 다르다. 저장하지 않고 새 내용을 다시 보여 주게 한다.
  const policyDays = await rejoinDaysToAgree(db, input.sellerId);
  const rejoinDays = policyDays !== null && input.agreedRejoinRetention === true ? policyDays : null;
  if (rejoinDays !== null && input.rejoinRestrictionDaysShown !== rejoinDays) return { ok: false, reason: "rejoin_policy_changed" };
  if (rejoinDays !== null && input.rejoinRetentionVersionShown !== REJOIN_RETENTION_CONSENT_VERSION) return { ok: false, reason: "consent_outdated" };
  if (
    !v.ciHash ||
    !v.verifiedAt ||
    !v.name ||
    !v.phone ||
    !v.birthDate ||
    v.expiresAt <= now ||
    now.getTime() - v.verifiedAt.getTime() > SIGNUP_WINDOW_MS
  ) {
    return { ok: false, reason: "verification_invalid" };
  }
  // 이 쇼핑몰의 기간이 끝난 재가입 제한 기록을 지운다(전역 정리는 jobs/scheduler.ts 정기 실행).
  // 본인확인(시작한 브라우저·완료·기한)이 확인된 요청에서만 돌린다. 비인증 요청으로 DELETE를 반복시키지 못하게 한다.
  await purgeExpiredRejoinBlocks(db, now, input.sellerId);

  const grade = await db.memberGrade.findFirst({
    where: { sellerId: input.sellerId },
    orderBy: [{ sortOrder: "asc" }],
    select: { id: true },
  });
  if (!grade) return { ok: false, reason: "shop_unavailable" };

  // 비밀번호 해시는 잠금 밖에서 미리 만든다(잠금을 짧게)
  const passwordHash = await hashPassword(input.password);
  type Step =
    | { kind: "resume"; subjectId: string | null }
    | { kind: "fail"; reason: BuyerSignupFailure; rejoinAvailableAt?: Date }
    | { kind: "created"; id: string; broadcastNickname: string };
  try {
    // 같은 본인확인 건의 가입 처리는 이 잠금 아래에서 한 줄로 한다(동시에 다시 보낸 요청이 서로 엇갈리지 않게).
    // 순서: 다시 읽기 → 이미 소진됐으면 재전송 판정 → 시도 예약 → 중복 확인 → 소진·회원 생성·회원 기록.
    // 시도 횟수는 같은 트랜잭션에서 올리고, 중복 같은 실패는 값으로 돌려줘 커밋되게 해서 실패한 시도도 남긴다.
    const step = await db.$transaction(async (tx): Promise<Step> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_signup_v:${v.id}`}))`;
      const cur = await tx.identityVerification.findUniqueOrThrow({ where: { id: v.id }, select: { consumedAt: true, subjectId: true, useAttemptCount: true } });
      if (cur.consumedAt) return { kind: "resume", subjectId: cur.subjectId };
      if (cur.useAttemptCount >= MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION) return { kind: "fail", reason: "too_many_signup_attempts" };
      await tx.identityVerification.update({ where: { id: v.id }, data: { useAttemptCount: { increment: 1 } } });
      const live = { sellerId: input.sellerId, deletedAt: null };
      if (await tx.buyerMember.findFirst({ where: { ...live, OR: [{ ciHash: v.ciHash! }, { phone: v.phone! }] }, select: { id: true } })) {
        return { kind: "fail", reason: "already_member" };
      }
      const blockedUntil = await rejoinBlockedUntil(tx, input.sellerId, v.ciHash!, now);
      if (blockedUntil) return { kind: "fail", reason: "rejoin_restricted", rejoinAvailableAt: blockedUntil };
      if (await tx.buyerMember.findFirst({ where: { ...live, loginId }, select: { id: true } })) return { kind: "fail", reason: "login_id_taken" };
      if (await tx.buyerMember.findFirst({ where: { ...live, broadcastNickname: nickname }, select: { id: true } })) return { kind: "fail", reason: "nickname_taken" };
      await tx.identityVerification.update({ where: { id: v.id }, data: { consumedAt: now } });
      const created = await tx.buyerMember.create({
        data: {
          sellerId: input.sellerId,
          loginId,
          passwordHash,
          name: v.name!,
          phone: v.phone!,
          ciHash: v.ciHash!,
          identityVerifiedAt: v.verifiedAt!,
          birthDate: v.birthDate!,
          broadcastNickname: nickname,
          gradeId: grade.id,
          marketingConsentAt: agreedMarketing ? now : null,
          rejoinRestrictionDaysAgreed: rejoinDays,
          rejoinRetentionAgreedAt: rejoinDays !== null ? now : null,
          rejoinRetentionVersion: rejoinDays !== null ? REJOIN_RETENTION_CONSENT_VERSION : null,
          createdAt: now,
        },
      });
      // 이 본인확인으로 만든 회원을 남긴다(응답이 끊겨 다시 보낸 요청을 알아보는 데 쓴다)
      await tx.identityVerification.update({ where: { id: v.id }, data: { subjectId: created.id } });
      // 동의 기록(감사 로그)도 같은 트랜잭션에서 남긴다. 쓰지 못하면 회원 생성·본인확인 소진도 되돌린다.
      await writeAudit(tx, {
        actorType: "BUYER",
        actorId: created.id,
        sellerId: input.sellerId,
        action: "buyer.signup",
        ip: input.meta?.ip ?? null,
        userAgent: input.meta?.userAgent ?? null,
        after: {
          agreedTerms: true,
          agreedPrivacy: true,
          agreedMarketing,
          ...(rejoinDays !== null ? { agreedRejoinRetention: true, rejoinRetentionVersion: REJOIN_RETENTION_CONSENT_VERSION, rejoinRestrictionDays: rejoinDays } : {}),
          agreedAt: now.toISOString(),
        },
      });
      return { kind: "created", id: created.id, broadcastNickname: created.broadcastNickname };
    });
    if (step.kind === "resume") return resume(step.subjectId);
    if (step.kind === "fail") return { ok: false, reason: step.reason, ...(step.rejoinAvailableAt ? { rejoinAvailableAt: step.rejoinAvailableAt } : {}) };
    return { ok: true, memberId: step.id, broadcastNickname: step.broadcastNickname, resumed: false };
  } catch (e) {
    // 다른 본인확인으로 같은 값이 동시에 가입된 경우(부분 유니크 인덱스 이름으로 어느 값인지 구분한다).
    // 트랜잭션이 되돌려져 시도 예약도 사라졌으니, 같은 잠금 아래 짧은 트랜잭션으로 시도 횟수를 따로 남긴다.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_signup_v:${v.id}`}))`;
        await tx.identityVerification.updateMany({
          where: { id: v.id, consumedAt: null, useAttemptCount: { lt: MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION } },
          data: { useAttemptCount: { increment: 1 } },
        });
      });
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? e.message);
      if (target.includes("ciHash") || target.includes("phone")) return { ok: false, reason: "already_member" };
      if (target.includes("loginId")) return { ok: false, reason: "login_id_taken" };
      if (target.includes("broadcastNickname")) return { ok: false, reason: "nickname_taken" };
    }
    throw e;
  }
}

// 가입 실패 문구(해요체). 화면은 error 코드로 분기하고 message를 그대로 보여 준다.
export const BUYER_SIGNUP_MESSAGES: Record<BuyerSignupFailure | "daily_limit_exceeded" | "start_in_progress", string> = {
  invalid_login_id: "아이디로 쓸 이메일 주소를 다시 확인해 주세요",
  weak_password: "비밀번호는 8자 이상으로 정해 주세요",
  invalid_nickname: "방송 닉네임은 20자까지, 쓸 수 있는 글자로 정해 주세요",
  terms_required: "필수 약관에 동의해 주세요",
  invalid_marketing_consent: "마케팅 정보 수신 동의를 다시 선택해 주세요",
  verification_pending: "인증번호 확인을 먼저 마쳐 주세요",
  verification_invalid: "본인확인을 처음부터 다시 해 주세요",
  too_many_signup_attempts: "가입을 여러 번 시도했어요. 본인확인을 처음부터 다시 해 주세요",
  already_member: "이미 이 쇼핑몰에 가입했어요. 로그인해 주세요",
  login_id_taken: "이미 가입한 이메일이에요. 다른 이메일로 가입해 주세요",
  nickname_taken: "이미 쓰고 있는 방송 닉네임이에요. 다른 닉네임으로 정해 주세요",
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  rejoin_restricted: "지금은 다시 가입할 수 없어요",
  invalid_rejoin_consent: "재가입 제한 정보 보관 동의 값을 다시 확인해 주세요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요",
  rejoin_policy_changed: "재가입 제한 기간이 바뀌었어요. 바뀐 내용을 확인하고 다시 동의해 주세요",
  daily_limit_exceeded: "오늘은 본인확인을 더 할 수 없어요. 내일 다시 해 주세요",
  start_in_progress: "인증번호를 보내고 있어요. 잠시 뒤 다시 시도해 주세요",
};

export const BUYER_SIGNUP_STATUS: Record<BuyerSignupFailure, number> = {
  invalid_login_id: 400,
  weak_password: 400,
  invalid_nickname: 400,
  terms_required: 400,
  invalid_marketing_consent: 400,
  verification_pending: 409,
  verification_invalid: 400,
  too_many_signup_attempts: 429,
  already_member: 409,
  login_id_taken: 409,
  nickname_taken: 409,
  shop_unavailable: 402,
  rejoin_restricted: 403,
  invalid_rejoin_consent: 400,
  consent_outdated: 409,
  rejoin_policy_changed: 409,
};
