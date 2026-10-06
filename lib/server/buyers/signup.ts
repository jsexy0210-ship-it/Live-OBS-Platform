import { Prisma, type IdentityVerification, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { hashPassword, verifyPassword } from "../auth/password";
import { MAX_EMAIL_LENGTH, normalizeEmail } from "../auth/login";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { sellerHasFeature } from "../billing/features";
import { dbNow, sellerAccessFor } from "../billing/subscription";
import { birthDateOf, type IdentityProvider } from "../identity/provider";
import { randomUUID } from "node:crypto";
import { START_IN_PROGRESS_MESSAGE, keyedOwnerToken as keyedToken, reuseKeyedAttempt } from "../identity/attempt";
import { hashToken } from "../auth/token";
import { buyerSignupIdentityLimitReached, completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { EMAIL } from "../sellers/application";
import { type ConsentFailure, currentConsentDocs, parseSignupConsent, readSignupConsent } from "./consent";
import { purgeExpiredRejoinBlocks, rejoinBlockedUntil, rejoinDaysToAgree } from "./rejoin";
import { cleanText } from "../text/clean";

type Db = PrismaClient | Prisma.TransactionClient;


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

// 가입할 수 있는 최소 만 나이
export const MIN_SIGNUP_AGE = 14;

// 생년월일(DB date, UTC 0시로 들어옴) 기준 KST 오늘의 만 나이. 생일 당일에 한 살 많아진다(2월 29일생은 평년에 3월 1일).
export function kstAge(birthDate: Date, now: Date): number {
  const today = new Date(now.getTime() + 9 * 3600_000);
  const [ty, tm, td] = [today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()];
  const [by, bm, bd] = [birthDate.getUTCFullYear(), birthDate.getUTCMonth() + 1, birthDate.getUTCDate()];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

// 운영 중(운영 상태 OPEN)이고 잠기지 않았고 스토어 운영 기능 권한이 있는 쇼핑몰만 가입을 받는다(주문과 같은 기준, DB 시계).
// 공유 미리보기·공유 카드도 이 기준이다(ARCHITECTURE 4.8.0 공개·구매자 경로 표).
export async function shopOpen(db: PrismaClient, sellerId: string) {
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { status: true, operatingState: true } });
  return !!seller && seller.operatingState === "OPEN" && (await orderServiceOpenFor(db, sellerId, seller.status));
}

// 이미 낸 주문의 반품·환불·현금영수증 요청 조건(대표님 결정 2026-10-06): 운영 상태(준비 중·일시 정지)와 상관없이 받는다.
// 이용 정지·구독 만료·스토어 운영 권한 없음일 때는 shopOpen과 같이 막는다. 새 거래(주문·가입 등)에는 쓰지 않는다.
export async function orderServiceOpen(db: PrismaClient, sellerId: string) {
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
  return !!seller && (await orderServiceOpenFor(db, sellerId, seller.status));
}

async function orderServiceOpenFor(db: PrismaClient, sellerId: string, status: string) {
  return status === "ACTIVE" && (await sellerAccessFor(db, sellerId)) !== "expired" && (await sellerHasFeature(db, sellerId, "STORE_OPERATIONS"));
}

// 첫 문자를 보내는 중으로 보는 시간. 공급자 호출 제한시간(10초)보다 넉넉하게 잡는다. 이 시간이 지나도 보낸 기록이 없으면
// 앞 요청이 멈춘 것으로 보고 같은 키 재요청이 그 기록을 버리고 새로 시작한다.
export { FIRST_SEND_WINDOW_MS } from "../identity/attempt";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// attemptKey로 시작한 기록의 ownerToken(identity/attempt.ts keyedOwnerToken)
const keyedOwnerToken = (attemptKey: string, verificationId: string) => keyedToken("buyer_signup_owner", attemptKey, verificationId);

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
  // 가입 필수 동의는 본인확인 요청 전에 받는다(PRODUCT_SCOPE 「동의 순서」). 같은 요청 본문의 동의 값·문서 버전이 없거나 다르면 새로 시작하지 않는다.
  // 같은 attemptKey로 이미 시작한 기록이 있으면(응답 유실 뒤 재시도) 그사이 문서 버전·재가입 제한 정책이 바뀌어도 그 기록을 돌려준다
  // (그 기록에는 시작 때 확인한 동의가 묶여 있다). 동의 검사는 새 기록을 만들 때만 적용한다.
  const consent = parseSignupConsent(rawPerson, await rejoinDaysToAgree(db, sellerId), meta.now ?? new Date(), await currentConsentDocs(db, sellerId));
  if (meta.attemptKey !== undefined && (typeof meta.attemptKey !== "string" || !UUID_RE.test(meta.attemptKey))) {
    return { ok: false as const, reason: "invalid_identity_input" as const };
  }
  const attemptKey = typeof meta.attemptKey === "string" ? meta.attemptKey.toLowerCase() : null;
  const keyHash = attemptKey ? hashToken(attemptKey) : null;
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false as const, reason: "invalid_identity_input" as const };
  // 입력한 생년월일로 만 14세 미만이면 공급자 호출·기록·일일 횟수 없이 거절한다(가입 때 본인확인 결과 생년월일로 다시 확인).
  if (kstAge(birthDateOf(person.birth7)!, meta.now ?? new Date()) < MIN_SIGNUP_AGE) return { ok: false as const, reason: "under_age" as const };
  const ip = meta.ip ?? null;
  type Started =
    | { kind: "reused"; verificationId: string; ownerToken: string }
    | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "trial_limit_exceeded" | "start_in_progress" }
    | { kind: "limited" }
    | { kind: "consent"; reason: ConsentFailure }
    | { kind: "send"; verification: IdentityVerification; ownerToken: string };
  const started = await db.$transaction(async (tx): Promise<Started> => {
    const now = meta.now ?? (await dbNow(tx));
    if (keyHash) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_signup_key:${sellerId}:${keyHash}`}))`;
      const same = await tx.identityVerification.findUnique({ where: { sellerId_attemptKeyHash: { sellerId, attemptKeyHash: keyHash } } });
      const r = await reuseKeyedAttempt(tx, same, now);
      if (r?.kind === "reused") return { kind: "reused", verificationId: r.verificationId, ownerToken: keyedOwnerToken(attemptKey!, r.verificationId) };
      if (r) return r;
    }
    if (!consent.ok) return { kind: "consent", reason: consent.reason };
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
      signupConsent: consent.consent,
      now: meta.now,
    });
    return { kind: "send", verification: created.verification, ownerToken: created.ownerToken };
  });
  if (started.kind === "reused") return { ok: true as const, verificationId: started.verificationId, ownerToken: started.ownerToken };
  if (started.kind === "refused") return { ok: false as const, reason: started.reason };
  if (started.kind === "consent") return { ok: false as const, reason: started.reason };
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
  | "invalid_marketing_consent" // 마케팅 수신 동의 값이 불리언이 아님(본인확인 시작)
  | "verification_pending"
  | "verification_invalid"
  | "too_many_signup_attempts"
  | "already_member"
  | "login_id_taken"
  | "nickname_taken"
  | "shop_unavailable"
  | "under_age" // 만 14세 미만(본인확인 시작 때 입력한 생년월일, 가입 때 본인확인 결과 생년월일)
  | "rejoin_restricted" // 재가입 제한 기간 중(탈퇴한 같은 사람, buyers/rejoin.ts)
  | "invalid_rejoin_consent" // 재가입 제한 정보 보관 동의 값이 불리언이 아님(본인확인 시작)
  | "rejoin_policy_changed" // 보관에 동의한 경우: 화면에 보여 준 재가입 제한 기간이 지금 정책과 다름(본인확인 시작, 화면을 다시 불러와 다시 동의)
  | "consent_outdated"; // 화면이 보여 준 동의 문서 버전(필수 약관, 동의한 경우 재가입 제한 보관)이 지금과 다름(본인확인 시작)

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
    // 필수 약관·재가입 제한 보관·마케팅 수신 동의는 본인확인 시작 때 받아 본인확인 기록에 있다(여기서 받지 않는다).
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
  // 본인확인 시작 때 받은 동의. 없으면(이 변경 전 요청) 처음부터 다시 한다.
  const consent = readSignupConsent(v.signupConsent);
  if (!consent) return { ok: false, reason: "verification_invalid" };
  // 재가입 제한 보관 동의를 했으면 그때 안내한 기간을 회원에 남긴다(설정이 그 뒤 바뀌어도 동의한 값 기준)
  const rejoinDays = consent.rejoinRetention?.days ?? null;
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
  // 만 14세 미만은 가입할 수 없다(MASTER 결정 2026-10-03, 법정대리인 동의 기능 전까지). 본인확인 생년월일·KST 날짜 기준이고
  // 같은 본인확인으로 몇 번 다시 해도 결과가 같아 시도 횟수에 넣지 않는다.
  if (kstAge(v.birthDate, now) < MIN_SIGNUP_AGE) return { ok: false, reason: "under_age" };
  // 이 쇼핑몰의 기간이 끝난 재가입 제한 기록·끝난 미가입 본인확인·3개월 지난 요청 IP를 정리한다(전역 정리는 jobs/scheduler.ts 정기 실행).
  // 본인확인(시작한 브라우저·완료·기한)이 확인된 요청에서만 돌린다. 비인증 요청으로 정리 쿼리를 반복시키지 못하게 한다.
  await purgeExpiredRejoinBlocks(db, now, input.sellerId);
  await purgeSignupVerificationsForShop(db, input.sellerId);

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
      const cur = await tx.identityVerification.findUniqueOrThrow({ where: { id: v.id }, select: { consumedAt: true, subjectId: true, useAttemptCount: true, anonymizedAt: true } });
      if (cur.consumedAt) return { kind: "resume", subjectId: cur.subjectId };
      // 처음 읽은 뒤 미가입 정리(purgeUnfinishedSignupVerifications)가 비식별했으면 쓸 수 없다
      if (cur.anonymizedAt) return { kind: "fail", reason: "verification_invalid" };
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
      // 소진은 「아직 안 썼고 비식별 전」일 때만 한 문장으로 한다. 정리 작업과 겹치면 먼저 커밋한 쪽만 행을 바꾼다
      // (정리가 먼저면 여기서 0건 → 거부, 가입이 먼저면 정리 조건 consumedAt IS NULL에 걸리지 않음).
      const consumed = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null, anonymizedAt: null }, data: { consumedAt: now } });
      if (consumed.count !== 1) return { kind: "fail", reason: "verification_invalid" };
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
          // 마케팅 수신 동의 시각은 본인확인 시작 때 동의한 시각이다
          marketingConsentAt: consent.marketing ? new Date(consent.agreedAt) : null,
          marketingConsentVersion: consent.marketing?.version ?? null,
          signupConsent: consent,
          rejoinRestrictionDaysAgreed: rejoinDays,
          rejoinRetentionAgreedAt: consent.rejoinRetention ? new Date(consent.agreedAt) : null,
          rejoinRetentionVersion: consent.rejoinRetention?.version ?? null,
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
          agreedMarketing: consent.marketing !== null,
          ...(consent.marketing ? { marketingVersion: consent.marketing.version } : {}),
          termsVersion: consent.termsVersion,
          privacyVersion: consent.privacyVersion,
          ...(consent.rejoinRetention
            ? { agreedRejoinRetention: true, rejoinRetentionVersion: consent.rejoinRetention.version, rejoinRestrictionDays: consent.rejoinRetention.days }
            : {}),
          // 동의(필수·선택)는 본인확인 시작 때(consentAgreedAt), agreedAt은 가입 시각
          consentAgreedAt: consent.agreedAt,
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
  under_age: "만 14세 미만은 가입할 수 없어요",
  rejoin_restricted: "지금은 다시 가입할 수 없어요",
  invalid_rejoin_consent: "재가입 제한 정보 보관 동의를 다시 선택해 주세요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요",
  rejoin_policy_changed: "재가입 제한 기간이 바뀌었어요. 바뀐 내용을 확인하고 다시 동의해 주세요",
  daily_limit_exceeded: "오늘은 본인확인을 더 할 수 없어요. 내일 다시 해 주세요",
  start_in_progress: START_IN_PROGRESS_MESSAGE,
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
  under_age: 403,
  rejoin_restricted: 403,
  invalid_rejoin_consent: 400,
  consent_outdated: 409,
  rejoin_policy_changed: 409,
};

// 가입을 끝내지 않은 본인확인 기록 비식별(PRODUCT_SCOPE 「동의 순서」·PRIVACY_CONSENT_TEMPLATE: 확인 시간이 끝나면 바로 지움).
// 대상: 구매자 가입용이고 가입에 쓰지 않았으며(consumedAt 없음) 유효 시간(expiresAt)이 지났고 아직 비식별하지 않은 기록.
// 이름·휴대폰·요청 휴대폰·생년월일·CI 해시·subjectId·동의·시작 브라우저 값(ownerTokenHash)을 비우고, 대행사에서 결과를 다시 조회하는
// 열쇠인 requestId는 겹치지 않는 무작위 값으로 바꾼다. 행은 지우지 않는다(MASTER 결정 2026-10-03, Codex P1): 쇼핑몰·상태·요청 시각·요청 IP로
// 같은 IP 하루 시작 횟수와 체험 한도(VERIFIED 건수)를 세므로, 지우거나 상태를 바꾸면 만료를 기다려 유료 문자를 다시 받는 남용이 된다.
// 요청 IP는 purgeOldSignupVerificationIps가 3개월 뒤 비운다. 정기 실행(jobs/scheduler.ts)과 가입·탈퇴 처리 때 부른다. 비식별한 수를 돌려준다.
export async function purgeUnfinishedSignupVerifications(db: Db, now?: Date, sellerId?: string): Promise<number> {
  const at = now ?? (await dbNow(db));
  return db.$executeRaw`
    UPDATE "IdentityVerification"
    SET "name" = NULL, "phone" = NULL, "requestedPhone" = NULL, "birthDate" = NULL, "ciHash" = NULL, "subjectId" = NULL,
        "signupConsent" = NULL, "ownerTokenHash" = NULL, "requestId" = 'anonymized:' || gen_random_uuid()::text, "anonymizedAt" = ${at}
    WHERE "purpose" = 'BUYER_SIGNUP' AND "consumedAt" IS NULL AND "anonymizedAt" IS NULL AND "expiresAt" <= ${at}
      AND (${sellerId ?? null}::uuid IS NULL OR "sellerId" = ${sellerId ?? null}::uuid)`;
}

// 구매자 가입 본인확인 기록의 요청 IP는 3개월 뒤 비운다(접속 기록 보관 3개월, PRODUCT_SCOPE 「구매자 탈퇴·재가입」).
// 가입을 마친 기록과 비식별한 미가입 기록이 대상이다. sellerId를 주면 그 쇼핑몰만. 정기 실행(jobs/scheduler.ts)과 가입·탈퇴 처리 때 부른다. 비운 수를 돌려준다.
export const SIGNUP_IP_RETENTION_MONTHS = 3;
export async function purgeOldSignupVerificationIps(db: Db, now?: Date, sellerId?: string): Promise<number> {
  const at = now ?? (await dbNow(db));
  const [{ before }] = await db.$queryRaw<{ before: Date }[]>`SELECT (${at}::timestamptz - make_interval(months => ${SIGNUP_IP_RETENTION_MONTHS}::int)) AS "before"`;
  const r = await db.identityVerification.updateMany({
    where: { purpose: "BUYER_SIGNUP", OR: [{ consumedAt: { not: null } }, { anonymizedAt: { not: null } }], requestIp: { not: null }, createdAt: { lte: before }, ...(sellerId ? { sellerId } : {}) },
    data: { requestIp: null },
  });
  return r.count;
}

// 가입·탈퇴 처리 때 그 쇼핑몰의 끝난 미가입 본인확인과 3개월 지난 요청 IP를 정리한다(모든 쇼핑몰은 정기 실행).
export async function purgeSignupVerificationsForShop(db: Db, sellerId: string, now?: Date) {
  const at = now ?? (await dbNow(db));
  await purgeUnfinishedSignupVerifications(db, at, sellerId);
  await purgeOldSignupVerificationIps(db, at, sellerId);
}
