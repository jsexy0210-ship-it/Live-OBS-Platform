import type { IdentityVerification, IdentityVerificationPurpose, Prisma, PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { generateToken, hashToken } from "../auth/token";
import { checkTrialLimit } from "../billing/trialLimits";
import { cleanText } from "../text/clean";
import { hashCi } from "./ciHash";
import { CARRIERS, DEVICES, birthDateOf, type Carrier, type Device, type IdentityPerson, type IdentityProvider, type IdentityResult, type ProviderFailure } from "./provider";

type IdentityResultOk = Extract<IdentityResult, { ok: true }>;

// 휴대폰 본인확인(문자) 흐름(PRODUCT_SCOPE 「휴대폰 본인확인 방식」).
// 시작(인적사항 → 요청 기록, 시작한 브라우저에만 ownerToken) → 인증번호 보내기 → (다시 보내기) → 인증번호 확인
// → 서버 결과 조회로 VERIFIED 확정 → 가입·재설정에서 한 번만 사용(consumedAt).
// - 요청은 시작한 쪽(쇼핑몰·용도·ownerToken)에 묶는다. 하나라도 다르면 없는 것으로 본다.
// - 대행사 결과는 요청 id·서비스(용도)·요청 때 휴대폰번호가 우리 기록과 같을 때만 믿는다.
// - 공급자 장애·타임아웃은 실패로 처리한다(성공으로 넘기지 않는다). 인증번호·비밀키는 기록·응답에 남기지 않는다.

// 시작부터 본인확인을 마쳐야 하는 시간
export const REQUEST_TTL_MS = 10 * 60_000;
// 인증번호 유효 시간(마지막으로 보낸 때부터). 대행사 규격을 알게 되면 맞춘다.
export const OTP_TTL_MS = 3 * 60_000;
// 다시 보내기 간격과 보낼 수 있는 횟수(처음 포함)
export const RESEND_INTERVAL_MS = 30_000;
export const MAX_CODE_SENDS = 4;
// 인증번호를 이만큼 틀리면 이 요청은 실패로 끝난다(처음부터 다시)
export const MAX_OTP_FAILURES = 5;
// 확인을 마친 뒤 가입·비밀번호 재설정에 쓸 수 있는 시간
export const VERIFIED_USE_TTL_MS = 10 * 60_000;
// 공급자 호출 하나의 제한 시간. 넘으면 장애로 본다.
export const IDENTITY_PROVIDER_TIMEOUT = { ms: 10_000 };

type Db = PrismaClient | Prisma.TransactionClient;
type Owner = { sellerId: string | null; purpose: IdentityVerificationPurpose; ownerToken: string | undefined };

const PROVIDER_ERROR: ProviderFailure = { ok: false, reason: "provider_error" };

// 공급자 호출: 예외·제한 시간 초과는 provider_error로 바꾼다.
async function call<T>(p: Promise<T>): Promise<T | ProviderFailure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderFailure>((resolve) => {
    timer = setTimeout(() => resolve(PROVIDER_ERROR), IDENTITY_PROVIDER_TIMEOUT.ms);
  });
  try {
    return await Promise.race([p.catch(() => PROVIDER_ERROR), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 대행사에 보내는 요청 id. 포트원 identityVerificationId는 영문·숫자만, 40자 이하라서 hex 32자로 만든다.
export const newIdentityRequestId = () => randomBytes(16).toString("hex");

// 인적사항 검사. 휴대폰번호는 숫자만 남긴다. 생년월일+성별 자리 7자리, 통신사(알뜰폰 포함), 화면 기기(PC·MOBILE, 없으면 MOBILE).
// 주민번호 전체는 받지 않는다.
export function parseIdentityPerson(raw: unknown): IdentityPerson | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const name = cleanText(b.name, 30);
  const phone = typeof b.phone === "string" ? b.phone.normalize("NFKC").replace(/[ -]/g, "") : "";
  const birth7 = typeof b.birth7 === "string" ? b.birth7.normalize("NFKC").replace(/[ -]/g, "") : "";
  const carrier = typeof b.carrier === "string" && (CARRIERS as readonly string[]).includes(b.carrier) ? (b.carrier as Carrier) : null;
  const device = b.device === undefined ? "MOBILE" : typeof b.device === "string" && (DEVICES as readonly string[]).includes(b.device) ? (b.device as Device) : null;
  if (!name || !carrier || !device || !/^01\d{8,9}$/.test(phone) || !birthDateOf(birth7)) return null;
  return { name, phone, birth7, carrier, device };
}

// 요청 기록만 만든다(공급자 호출 없음, 트랜잭션 안에서 불러도 된다). 인증번호는 sendFirstIdentityCode로 보낸다.
export async function startIdentityVerification(
  db: Db,
  provider: IdentityProvider,
  input: { purpose: IdentityVerificationPurpose; sellerId: string | null; person: IdentityPerson; subjectId?: string | null; requestIp?: string | null; now?: Date },
): Promise<{ verification: IdentityVerification; ownerToken: string }> {
  const now = input.now ?? new Date();
  const ownerToken = generateToken();
  const verification = await db.identityVerification.create({
    data: {
      purpose: input.purpose,
      sellerId: input.sellerId,
      subjectId: input.subjectId ?? null,
      requestIp: input.requestIp ?? null,
      provider: provider.name,
      method: "SMS",
      requestId: newIdentityRequestId(),
      requestedPhone: input.person.phone,
      ownerTokenHash: hashToken(ownerToken),
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      ...(input.now ? { createdAt: input.now } : {}),
    },
  });
  return { verification, ownerToken };
}

// 첫 인증번호 보내기. 공급자 장애·타임아웃이면 이 요청은 실패로 끝낸다(처음부터 다시).
export async function sendFirstIdentityCode(
  db: PrismaClient,
  provider: IdentityProvider,
  v: IdentityVerification,
  person: IdentityPerson,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; reason: "provider_error" }> {
  const r = await call(provider.sendCode(v.requestId, v.purpose, person));
  if (!r.ok) {
    await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "FAILED" } });
    return { ok: false, reason: "provider_error" };
  }
  await db.identityVerification.update({ where: { id: v.id }, data: { sendCount: 1, lastSentAt: now } });
  return { ok: true };
}

// 시작한 쪽 확인: 쇼핑몰·용도·ownerToken·공급자가 하나라도 다르면 없는 것으로 본다(다른 세션의 요청 id를 써도 막힘).
async function ownedVerification(db: Db, provider: IdentityProvider, id: string, owner: Owner) {
  const v = await db.identityVerification.findUnique({ where: { id } });
  if (
    !v ||
    v.provider !== provider.name ||
    v.sellerId !== owner.sellerId ||
    v.purpose !== owner.purpose ||
    !owner.ownerToken ||
    v.ownerTokenHash !== hashToken(owner.ownerToken)
  ) {
    return null;
  }
  return v;
}

export type ResendResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "failed" | "already_verified" | "resend_too_soon" | "resend_limit" | "provider_error" | "trial_limit_exceeded" };

// 체험하기 중 구매자 가입 본인확인 한도가 이미 찼는지(문자를 보내기 전 미리 확인). 최종 확인은 확정할 때(finalizeIdentity) 잠금 아래에서 다시 한다.
export async function buyerSignupIdentityLimitReached(db: Db, sellerId: string, now?: Date): Promise<boolean> {
  return !(await checkTrialLimit(db, sellerId, "identity", { used: () => identityUsage(db, sellerId), adding: 1 }, now)).ok;
}

// 인증번호 다시 보내기. 간격·횟수 제한은 조건부 갱신으로 지켜 동시에 눌러도 한 번만 보낸다.
export async function resendIdentityCode(db: PrismaClient, provider: IdentityProvider, id: string, owner: Owner, now = new Date()): Promise<ResendResult> {
  const v = await ownedVerification(db, provider, id, owner);
  if (!v) return { ok: false, reason: "not_found" };
  if (v.status === "VERIFIED") return { ok: false, reason: "already_verified" };
  if (v.status !== "PENDING") return { ok: false, reason: v.status === "EXPIRED" ? "expired" : "failed" };
  if (v.expiresAt <= now) {
    await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    return { ok: false, reason: "expired" };
  }
  if (v.sendCount === 0) return { ok: false, reason: "failed" };
  if (v.sendCount >= MAX_CODE_SENDS) return { ok: false, reason: "resend_limit" };
  if (v.lastSentAt && v.lastSentAt.getTime() + RESEND_INTERVAL_MS > now.getTime()) return { ok: false, reason: "resend_too_soon" };
  // 한도가 찬 쇼핑몰이면 확정할 수 없으니 문자를 다시 보내지 않는다
  if (v.purpose === "BUYER_SIGNUP" && v.sellerId && (await buyerSignupIdentityLimitReached(db, v.sellerId, now))) return { ok: false, reason: "trial_limit_exceeded" };
  const reserved = await db.identityVerification.updateMany({
    where: { id: v.id, status: "PENDING", sendCount: v.sendCount, lastSentAt: v.lastSentAt },
    data: { sendCount: { increment: 1 }, lastSentAt: now },
  });
  if (reserved.count !== 1) return { ok: false, reason: "resend_too_soon" };
  const r = await call(provider.resendCode(v.requestId));
  return r.ok ? { ok: true } : { ok: false, reason: "provider_error" };
}

export type ConfirmResult =
  | { ok: true; verification: IdentityVerification }
  | { ok: false; reason: "not_found" | "expired" | "failed" | "wrong_code" | "code_expired" | "too_many_attempts" | "provider_error" | "trial_limit_exceeded" };

// 인증번호 확인 → 서버 결과 조회 → VERIFIED. 중복 클릭은 같은 결과를 돌려주고, 상태 전환은 한 번만 일어난다.
export async function confirmIdentityCode(
  db: PrismaClient,
  provider: IdentityProvider,
  id: string,
  owner: Owner,
  otp: unknown,
  now = new Date(),
): Promise<ConfirmResult> {
  const v = await ownedVerification(db, provider, id, owner);
  if (!v) return { ok: false, reason: "not_found" };
  if (v.status === "VERIFIED") return v.expiresAt > now ? { ok: true, verification: v } : { ok: false, reason: "expired" };
  if (v.status !== "PENDING") return { ok: false, reason: v.status === "EXPIRED" ? "expired" : "failed" };
  if (v.expiresAt <= now) {
    await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    return { ok: false, reason: "expired" };
  }
  // 운영에서는 가짜 공급자 기록을 완료 처리하지 않는다(공급자 객체를 우회해 만든 경우까지 막는다).
  if (v.provider === "fake" && process.env.NODE_ENV === "production") return { ok: false, reason: "failed" };
  const finalize = (r: IdentityResultOk) => finalizeIdentity(db, v, r, now);

  // 틀린 시도: 잡아 둔 1회를 그대로 두고, 한도에 닿았으면 요청을 실패로 끝낸다.
  const wrong = async (): Promise<ConfirmResult> => {
    const after = await db.identityVerification.findUniqueOrThrow({ where: { id: v.id }, select: { otpFailCount: true } });
    if (after.otpFailCount >= MAX_OTP_FAILURES) {
      await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "FAILED" } });
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "wrong_code" };
  };
  // 잡아 둔 1회를 돌려준다(공급자 장애이거나 이미 확정된 경우)
  const release = () => db.identityVerification.updateMany({ where: { id: v.id, otpFailCount: { gt: 0 } }, data: { otpFailCount: { decrement: 1 } } });
  // 이미 확정됐는지 다시 본다: 같은 요청의 다른 확인이 먼저 끝났거나(중복 클릭), 앞선 확인이 시간 초과 뒤 실제로는 성공한 경우.
  // DB가 VERIFIED면 그 결과, 아니면 대행사 결과 조회로 확인해 확정한다. 확인되지 않으면 null.
  const recover = async (): Promise<ConfirmResult | null> => {
    const current = await db.identityVerification.findUniqueOrThrow({ where: { id: v.id } });
    if (current.status === "VERIFIED") return { ok: true, verification: current };
    if (current.status !== "PENDING") return null;
    const r = await call(provider.fetchResult(v.requestId));
    return r.ok ? finalize(r) : null;
  };

  // 시도를 잡지 못함(횟수를 다 씀): 마지막 시도에서 대행사 확인은 됐는데 결과 조회만 실패했을 수 있으니,
  // 아직 PENDING이면 결과를 한 번 다시 조회해 확정한다. 아니면 too_many_attempts.
  const exhausted = async (): Promise<ConfirmResult> => {
    const recovered = await recover();
    if (recovered) return recovered;
    const current = await db.identityVerification.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } });
    return { ok: false, reason: current.status === "PENDING" ? "too_many_attempts" : "failed" };
  };

  // 횟수를 다 쓴 요청은 인증번호를 다시 확인하지 않고 결과만 조회하므로, 인증번호 유효 시간과 상관없이 먼저 복구를 시도한다
  // (요청 자체의 만료는 위에서 이미 확인했다. 결과가 미인증이면 성공으로 치지 않는다).
  if (v.otpFailCount >= MAX_OTP_FAILURES) return exhausted();
  if (!v.lastSentAt) return { ok: false, reason: "failed" };
  if (v.lastSentAt.getTime() + OTP_TTL_MS <= now.getTime()) return { ok: false, reason: "code_expired" };

  // 공급자를 부르기 전에 시도 1회를 조건부로 먼저 잡는다. 동시에 여러 번 보내도 남은 횟수만큼만 공급자를 부른다.
  const reserved = await db.identityVerification.updateMany({
    where: { id: v.id, status: "PENDING", otpFailCount: { lt: MAX_OTP_FAILURES } },
    data: { otpFailCount: { increment: 1 } },
  });
  if (reserved.count !== 1) return exhausted();
  if (typeof otp !== "string" || !/^\d{4,8}$/.test(otp)) return wrong();
  const confirmed = await call(provider.confirmCode(v.requestId, otp));
  if (!confirmed.ok) {
    const recovered = await recover();
    if (recovered) {
      await release();
      return recovered;
    }
    if (confirmed.reason === "wrong_code") return wrong();
    await release();
    return { ok: false, reason: "provider_error" };
  }

  const r = await call(provider.fetchResult(v.requestId));
  if (!r.ok) {
    if (r.reason === "failed") {
      await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "FAILED" } });
      return { ok: false, reason: "failed" };
    }
    return { ok: false, reason: "provider_error" };
  }
  return finalize(r);
}

// 대행사 결과를 대조하고 VERIFIED로 확정한다(한 번만). 다른 요청·다른 용도·요청 때와 다른 휴대폰번호의 결과면 실패로 끝낸다.
async function finalizeIdentity(db: PrismaClient, v: IdentityVerification, r: IdentityResultOk, now: Date): Promise<ConfirmResult> {
  // 공급자 결과도 입력과 같은 규칙으로 정리해 저장한다(이름: NFKC·앞뒤 공백·글자 검사, 휴대폰: 숫자만). 이름이 비거나 쓸 수 없으면 실패.
  const name = cleanText(r.name, 30);
  if (!name || r.requestId !== v.requestId || r.purpose !== v.purpose || r.phone.replace(/\D/g, "") !== v.requestedPhone) {
    await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "FAILED" } });
    return { ok: false, reason: "failed" };
  }

  return db.$transaction(async (tx) => {
    // 구매자 가입 본인확인은 체험하기 중 판매자 한도(trialIdentityLimit)를 쓴다. 성공 건수를 같은 잠금 아래에서 센다.
    if (v.purpose === "BUYER_SIGNUP" && v.sellerId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`identity_usage:${v.sellerId}`}))`;
      // 잠금을 기다리는 동안 같은 요청의 다른 확인이 먼저 확정했으면 그 결과를 돌려준다(한도로 다시 세지 않는다)
      const current = await tx.identityVerification.findUniqueOrThrow({ where: { id: v.id } });
      if (current.status === "VERIFIED") return { ok: true as const, verification: current };
      if (current.status !== "PENDING") return { ok: false as const, reason: current.status === "EXPIRED" ? ("expired" as const) : ("failed" as const) };
      const sellerId = v.sellerId;
      const limit = await checkTrialLimit(tx, sellerId, "identity", { used: () => identityUsage(tx, sellerId), adding: 1 }, now);
      if (!limit.ok) {
        await tx.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "FAILED" } });
        return { ok: false as const, reason: "trial_limit_exceeded" as const };
      }
    }
    const moved = await tx.identityVerification.updateMany({
      where: { id: v.id, status: "PENDING" },
      data: {
        status: "VERIFIED",
        ciHash: hashCi(r.ci),
        name,
        phone: r.phone.replace(/\D/g, ""),
        birthDate: r.birthDate,
        verifiedAt: now,
        expiresAt: new Date(now.getTime() + VERIFIED_USE_TTL_MS),
      },
    });
    const after = await tx.identityVerification.findUniqueOrThrow({ where: { id: v.id } });
    // 같이 눌린 다른 요청이 먼저 확정했으면 그 결과를 그대로 돌려준다(두 번 세지 않는다)
    if (moved.count === 1 || after.status === "VERIFIED") return { ok: true as const, verification: after };
    return { ok: false as const, reason: after.status === "EXPIRED" ? ("expired" as const) : ("failed" as const) };
  });
}

// 휴대폰 본인확인 사용량: 이 쇼핑몰에서 성공한 구매자 가입 본인확인 건수(성공 1건 = 1). 주문 알림 문자 발송량과 따로 센다.
export async function identityUsage(db: Db, sellerId: string): Promise<number> {
  return db.identityVerification.count({ where: { sellerId, purpose: "BUYER_SIGNUP", status: "VERIFIED" } });
}

export type CompleteResult =
  | { ok: true; verification: IdentityVerification }
  | { ok: false; reason: "not_found" | "expired" | "failed" | "pending" };

// 가입·재설정에서 쓰기 전 확인: 시작한 쪽이 같고, 확인을 마쳤고(VERIFIED), 쓸 수 있는 시간 안이어야 한다.
// 결과 확정은 confirmIdentityCode에서만 한다(여기서는 공급자를 다시 부르지 않는다).
export async function completeIdentityVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  verificationId: string,
  owner: Owner,
  now = new Date(),
): Promise<CompleteResult> {
  const v = await ownedVerification(db, provider, verificationId, owner);
  if (!v) return { ok: false, reason: "not_found" };
  if (v.status === "VERIFIED") return v.expiresAt > now ? { ok: true, verification: v } : { ok: false, reason: "expired" };
  if (v.status !== "PENDING") return { ok: false, reason: v.status === "EXPIRED" ? "expired" : "failed" };
  if (v.expiresAt <= now) {
    await db.identityVerification.updateMany({ where: { id: v.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "pending" };
}
