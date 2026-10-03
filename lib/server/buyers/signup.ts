import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { hashPassword } from "../auth/password";
import { MAX_EMAIL_LENGTH, normalizeEmail } from "../auth/login";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { sellerAccessFor } from "../billing/subscription";
import type { IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { EMAIL } from "../sellers/application";
import { cleanText } from "../text/clean";

class VerificationUsed extends Error {}

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

// 구매자 가입 1단계: 휴대폰 본인확인 시작(같은 IP·같은 쇼핑몰 하루 10회까지). 첫 인증번호를 보내고 ownerToken을 돌려준다.
export async function startBuyerSignupVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  sellerId: string,
  rawPerson: unknown,
  meta: { ip?: string | null; userAgent?: string | null; now?: Date } = {},
) {
  if (!(await shopOpen(db, sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false as const, reason: "invalid_identity_input" as const };
  const ip = meta.ip ?? null;
  const started = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_signup:${sellerId}:${ip ?? "unknown"}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'BUYER_SIGNUP' AND "sellerId" = ${sellerId}::uuid
        AND "requestIp" IS NOT DISTINCT FROM ${ip}
        AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP) return null;
    return startIdentityVerification(tx, provider, { purpose: "BUYER_SIGNUP", sellerId, person, requestIp: ip, now: meta.now });
  });
  if (!started) {
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
  | "verification_pending"
  | "verification_invalid"
  | "too_many_signup_attempts"
  | "already_member"
  | "login_id_taken"
  | "nickname_taken"
  | "shop_unavailable";

export type BuyerSignupResult = { ok: true; memberId: string } | { ok: false; reason: BuyerSignupFailure };

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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.verificationId)) return { ok: false, reason: "verification_invalid" };

  const done = await completeIdentityVerification(db, provider, input.verificationId, { sellerId: input.sellerId, purpose: "BUYER_SIGNUP", ownerToken: input.ownerToken }, now);
  if (!done.ok) return { ok: false, reason: done.reason === "pending" ? "verification_pending" : "verification_invalid" };
  const v = done.verification;
  if (
    v.consumedAt ||
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

  // 시도 횟수를 먼저 센다(가입이 중복으로 롤백돼도 남도록 별도 갱신). 한도에 닿으면 이 본인확인으로는 더 가입할 수 없다.
  const counted = await db.identityVerification.updateMany({
    where: { id: v.id, consumedAt: null, useAttemptCount: { lt: MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION } },
    data: { useAttemptCount: { increment: 1 } },
  });
  if (counted.count !== 1) return { ok: false, reason: "too_many_signup_attempts" };

  const existing = await db.buyerMember.findFirst({
    where: { sellerId: input.sellerId, ciHash: v.ciHash, deletedAt: null },
    select: { id: true },
  });
  if (existing) return { ok: false, reason: "already_member" };

  const grade = await db.memberGrade.findFirst({
    where: { sellerId: input.sellerId },
    orderBy: [{ sortOrder: "asc" }],
    select: { id: true },
  });
  if (!grade) return { ok: false, reason: "shop_unavailable" };

  const passwordHash = await hashPassword(input.password);
  try {
    const member = await db.$transaction(async (tx) => {
      // 같은 본인인증으로 두 번 가입하지 못하게 먼저 소진 처리한다.
      const used = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null }, data: { consumedAt: now } });
      if (used.count !== 1) throw new VerificationUsed();
      return tx.buyerMember.create({
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
          createdAt: now,
        },
      });
    });
    await writeAudit(db, {
      actorType: "BUYER",
      actorId: member.id,
      sellerId: input.sellerId,
      action: "buyer.signup",
      ip: input.meta?.ip ?? null,
      userAgent: input.meta?.userAgent ?? null,
      after: { agreedTerms: true, agreedPrivacy: true, agreedAt: now.toISOString() },
    });
    return { ok: true, memberId: member.id };
  } catch (e) {
    if (e instanceof VerificationUsed) return { ok: false, reason: "verification_invalid" };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // 부분 유니크 인덱스 이름으로 어느 값이 겹쳤는지 구분한다(동시에 가입한 경우 포함).
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? e.message);
      if (target.includes("ciHash") || target.includes("phone")) return { ok: false, reason: "already_member" };
      if (target.includes("loginId")) return { ok: false, reason: "login_id_taken" };
      if (target.includes("broadcastNickname")) return { ok: false, reason: "nickname_taken" };
    }
    throw e;
  }
}

// 가입 실패 문구(해요체). 화면은 error 코드로 분기하고 message를 그대로 보여 준다.
export const BUYER_SIGNUP_MESSAGES: Record<BuyerSignupFailure | "daily_limit_exceeded", string> = {
  invalid_login_id: "아이디로 쓸 이메일 주소를 다시 확인해 주세요",
  weak_password: "비밀번호는 8자 이상으로 정해 주세요",
  invalid_nickname: "방송 닉네임은 20자까지, 쓸 수 있는 글자로 정해 주세요",
  terms_required: "필수 약관에 동의해 주세요",
  verification_pending: "인증번호 확인을 먼저 마쳐 주세요",
  verification_invalid: "본인확인을 처음부터 다시 해 주세요",
  too_many_signup_attempts: "가입을 여러 번 시도했어요. 본인확인을 처음부터 다시 해 주세요",
  already_member: "이미 이 쇼핑몰에 가입했어요. 로그인해 주세요",
  login_id_taken: "이미 가입한 이메일이에요. 다른 이메일로 가입해 주세요",
  nickname_taken: "이미 쓰고 있는 방송 닉네임이에요. 다른 닉네임으로 정해 주세요",
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  daily_limit_exceeded: "오늘은 본인확인을 더 할 수 없어요. 내일 다시 해 주세요",
};

export const BUYER_SIGNUP_STATUS: Record<BuyerSignupFailure, number> = {
  invalid_login_id: 400,
  weak_password: 400,
  invalid_nickname: 400,
  terms_required: 400,
  verification_pending: 409,
  verification_invalid: 400,
  too_many_signup_attempts: 429,
  already_member: 409,
  login_id_taken: 409,
  nickname_taken: 409,
  shop_unavailable: 402,
};
