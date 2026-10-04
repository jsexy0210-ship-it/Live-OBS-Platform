import { Prisma, type IdentityVerification, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { normalizeEmail } from "../auth/login";
import { hashPassword, verifyPassword } from "../auth/password";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { hashToken } from "../auth/token";
import { dbNow } from "../billing/subscription";
import { keyedOwnerToken, parseAttemptKey, reuseKeyedAttempt, scopedAttemptKeyHash } from "../identity/attempt";
import type { IdentityProvider } from "../identity/provider";
import { parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { SIGNUP_PLAN_CODES } from "../billing/plans";
import { DEFAULT_PLAN_CODE } from "../billing/subscription";
import { activateSeller } from "./approval";
import {
  normalizeBusinessNumber,
  normalizeMailOrderNumber,
  normalizeOpenedOn,
  type BusinessStatusProvider,
  type MailOrderProvider,
} from "./businessCheck";
import { parseSellerSignupConsent, readSellerSignupConsent, type SellerConsentFailure } from "./signupConsent";

// 판매자 가입 신청과 자동 점검(대표님 결정 2026-10-02, PRODUCT_SCOPE 「판매자 가입 자동 승인」).
// 점검: 대표자 휴대폰 본인확인(필수) · 대표자 CI 중복(1인 1쇼핑몰) · 국세청 진위확인(대표자명·개업일 대조)·「계속사업자」 ·
// 같은 사업자번호로 운영·신청 중인 쇼핑몰 없음 · 통신판매업 신고 조회(공정위, 등록·사업자번호 일치·영업 정상).
// 모두 통과하면 바로 승인(체험하기 시작), 하나라도 걸리면 승인 대기로 두고 걸린 항목을 「확인 필요」 사유로 남긴다.
// 로그인 이메일·비밀번호는 신청자가 정한다.

const VERIFY_WINDOW_MS = 30 * 60_000;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_SLUGS = new Set(["admin", "api", "app", "www", "master", "seller", "shop", "static", "help", "support", "login", "signup", "overlay"]);
// 이메일 형식. 공백·제어·서식 문자(\p{C}, NUL 포함)는 받지 않는다(DB 오류 500 대신 형식 오류로).
export const EMAIL = /^[^\s@\p{C}]{1,64}@[^\s@\p{C}]{1,190}\.[^\s@\p{C}]{2,}$/u;

// 가입용 휴대폰 본인확인은 건당 비용이 들어 같은 접속 IP에서 하루(KST 자정 초기화) 10회까지만 시작한다(MASTER 결정 2026-10-03).
export const SIGNUP_VERIFY_DAILY_LIMIT_PER_IP = 10;
const OWNER_SCOPE = "seller_signup_owner";

// 대표자 1인 1쇼핑몰 위반 때 보여 줄 문구(다른 쇼핑몰 이름은 보여 주지 않음, MASTER 결정)
export const REPRESENTATIVE_HAS_SHOP_MESSAGE = "이미 운영 중인 쇼핑몰이 있어요 · 한 대표자는 쇼핑몰 하나만 열 수 있어요";

// 판매자 가입 휴대폰 본인확인 시작(필수 동의 검사(signupConsent.ts) → 인적사항 검사 → 요청 기록 → 첫 인증번호). IP별로 줄을 세워(advisory lock) 오늘(KST) 시작 건수를 DB 시계로 센 뒤 한도 안일 때만 시작한다.
// IP를 알 수 없으면(신뢰 프록시 미설정) 하나의 묶음으로 센다.
// attemptKey(선택, 클라이언트 UUID): 응답이 끊겨 같은 키로 다시 보내면 같은 기록·같은 ownerToken을 돌려주고 문자·일일 횟수를 다시 쓰지 않는다
// (identity/attempt.ts reuseKeyedAttempt, 보내는 중이면 409 start_in_progress).
export async function startSellerSignupVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  rawPerson: unknown,
  meta: { ip?: string | null; userAgent?: string | null; now?: Date; attemptKey?: unknown } = {},
) {
  const attemptKey = parseAttemptKey(meta.attemptKey);
  if (attemptKey === false) return { ok: false as const, reason: "invalid_identity_input" as const };
  const consent = parseSellerSignupConsent(rawPerson, meta.now ?? new Date());
  if (!consent.ok) return { ok: false as const, reason: consent.reason };
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false as const, reason: "invalid_identity_input" as const };
  const ip = meta.ip ?? null;
  const keyHash = attemptKey ? scopedAttemptKeyHash("SELLER_REPRESENTATIVE", "", attemptKey) : null;
  type Started =
    | null
    | { kind: "reused"; verificationId: string; ownerToken: string }
    | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "start_in_progress" }
    | { kind: "send"; verification: IdentityVerification; ownerToken: string };
  const started = await db.$transaction(async (tx): Promise<Started> => {
    if (keyHash) {
      const now = meta.now ?? (await dbNow(tx));
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`idv_key:${keyHash}`}))`;
      const same = await tx.identityVerification.findFirst({ where: { purpose: "SELLER_REPRESENTATIVE", sellerId: null, attemptKeyHash: keyHash } });
      const r = await reuseKeyedAttempt(tx, same, now);
      if (r?.kind === "reused") return { ...r, ownerToken: keyedOwnerToken(OWNER_SCOPE, attemptKey!, r.verificationId) };
      if (r) return r;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_signup:${ip ?? "unknown"}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'SELLER_REPRESENTATIVE'
        AND "requestIp" IS NOT DISTINCT FROM ${ip}
        AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= SIGNUP_VERIFY_DAILY_LIMIT_PER_IP) return null;
    const id = randomUUID();
    const created = await startIdentityVerification(tx, provider, {
      purpose: "SELLER_REPRESENTATIVE",
      sellerId: null,
      person,
      requestIp: ip,
      signupConsent: consent.consent,
      attemptKeyHash: keyHash,
      sendStartedAt: keyHash ? (meta.now ?? (await dbNow(tx))) : null,
      id,
      ownerToken: attemptKey ? keyedOwnerToken(OWNER_SCOPE, attemptKey, id) : undefined,
      now: meta.now,
    });
    return { kind: "send", ...created };
  });
  if (started?.kind === "reused") return { ok: true as const, verificationId: started.verificationId, ownerToken: started.ownerToken };
  if (started?.kind === "refused") return { ok: false as const, reason: started.reason };
  if (!started) {
    await writeAudit(db, {
      actorType: "SYSTEM",
      action: "seller.signup.verify_limited",
      reason: "daily_limit_exceeded",
      ip,
      userAgent: meta.userAgent,
    });
    return { ok: false as const, reason: "daily_limit_exceeded" as const };
  }
  const sent = await sendFirstIdentityCode(db, provider, started.verification, person, meta.now);
  if (!sent.ok) return { ok: false as const, reason: sent.reason };
  return { ok: true as const, verificationId: started.verification.id, ownerToken: started.ownerToken };
}

// 자동 점검에서 걸린 항목(「확인 필요」 사유)
export type ReviewReason =
  | "business_lookup_failed" // 국세청 조회 실패(키 없음·연동 전 포함)
  | "business_info_mismatch" // 진위확인 불일치(사업자번호·대표자명·개업일자)
  | "business_not_active" // 계속사업자 아님(휴업·폐업)
  | "business_duplicate" // 같은 사업자번호로 운영 중이거나 신청 중인 쇼핑몰이 있음
  | "mail_order_number_invalid" // 통신판매업 신고번호 없음·형식 틀림
  | "mail_order_lookup_failed" // 공정위 조회 실패(키 없음·연동 전 포함)
  | "mail_order_not_registered" // 등록 없음 또는 사업자번호 불일치
  | "mail_order_not_active"; // 영업 상태가 정상이 아님

export type ApplyInput = {
  verificationId: string;
  ownerToken: string | undefined;
  email: string;
  password: string;
  shopName: string;
  slug: string;
  businessNumber: string;
  companyName: string;
  // 개업일자(YYYYMMDD 또는 YYYY-MM-DD). 국세청 진위확인에 쓴다.
  openedOn: string;
  mailOrderNumber?: string | null;
  // 플랜(ONQ 1-C): OVERLAY_ONLY | INTEGRATED. 없으면 신규 가입 기본 플랜(DEFAULT_PLAN_CODE). 그 밖의 값은 invalid_input.
  // 가입 화면이 「지금 운영 중인 쇼핑몰이 있나요?」로 고르면 보낸다(ONQ 2단계).
  planCode?: string | null;
  meta?: { ip?: string | null; userAgent?: string | null };
  now?: Date;
};

export type ApplyFailure =
  | "verification_invalid"
  | "invalid_input"
  | "weak_password"
  | "invalid_slug"
  | "slug_taken"
  | "invalid_business_number"
  | "representative_has_shop"
  | SellerConsentFailure; // 본인확인 기록에 필수 동의가 없음(동의 저장 전에 시작한 기록, terms_required)

// resumed: 응답이 끊겨 같은 요청을 다시 보낸 경우(새로 만들지 않고 이미 만든 신청의 지금 상태를 돌려줌)
export type ApplyResult = { ok: true; sellerId: string; approved: boolean; reviewReasons: ReviewReason[]; resumed: boolean } | { ok: false; reason: ApplyFailure };

class Fail extends Error {
  constructor(readonly reason: ApplyFailure) {
    super(reason);
  }
}

// 같은 신청을 동시에 다시 보낸 경우: 두 요청이 모두 쓰지 않은 본인확인을 읽고 점검을 지나면, 늦은 쪽은 본인확인을 쓰는 조건부 변경에서 지거나
// (verification_invalid) 먼저 만든 쇼핑몰에 걸린다(representative_has_shop·slug_taken). 이때 그 행을 다시 읽어 재개 확인을 돌린다.
// 조건부 변경은 앞 요청이 같은 행을 잠근 채 커밋할 때까지 기다린 뒤 0행으로 끝나므로, 다시 읽을 때는 앞 요청의 결과가 이미 보인다
// (기다리기나 재시도 없이 행 잠금으로 순서가 정해짐). 조건이 맞으면 resumed, 아니면 원래 실패를 그대로 돌려준다.
export async function applyForSeller(
  db: PrismaClient,
  providers: { business: BusinessStatusProvider; mailOrder: MailOrderProvider },
  input: ApplyInput,
): Promise<ApplyResult> {
  const r = await applyOnce(db, providers, input);
  if (r.ok || !["verification_invalid", "representative_has_shop", "slug_taken"].includes(r.reason)) return r;
  const v = await db.identityVerification.findUnique({ where: { id: input.verificationId } });
  return (v && (await resumeApplication(db, v, input))) ?? r;
}

// 응답 유실 뒤 다시 보낸 같은 요청: 시작한 브라우저(ownerToken)의 이미 쓴 본인확인이 만든 대표자 계정(subjectId)이고
// 아이디·비밀번호·쇼핑몰 주소가 같으면 새로 만들지 않고 그 신청의 지금 상태(승인 여부·확인 필요 사유)를 돌려준다.
// 이미 쓴 이 브라우저의 본인확인이지만 조건이 다르면 verification_invalid, 재개 대상이 아니면 null.
async function resumeApplication(db: PrismaClient, v: IdentityVerification, input: ApplyInput): Promise<ApplyResult | null> {
  if (!(v.consumedAt && v.purpose === "SELLER_REPRESENTATIVE" && v.sellerId === null && input.ownerToken && v.ownerTokenHash === hashToken(input.ownerToken))) return null;
  const email = normalizeEmail(input.email);
  const slug = input.slug.trim().toLowerCase();
  const owner = v.subjectId ? await db.sellerUser.findUnique({ where: { id: v.subjectId }, include: { seller: { select: { id: true, slug: true, status: true, reviewReasons: true } } } }) : null;
  if (owner?.isOwner && owner.email === email && owner.seller.slug === slug && (await verifyPassword(owner.passwordHash, input.password))) {
    const approved = owner.seller.status === "ACTIVE";
    return { ok: true, sellerId: owner.seller.id, approved, reviewReasons: approved ? [] : (owner.seller.reviewReasons as ReviewReason[]), resumed: true };
  }
  return { ok: false, reason: "verification_invalid" };
}

async function applyOnce(
  db: PrismaClient,
  providers: { business: BusinessStatusProvider; mailOrder: MailOrderProvider },
  input: ApplyInput,
): Promise<ApplyResult> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const shopName = input.shopName.trim();
  const companyName = input.companyName.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!EMAIL.test(email) || !shopName || shopName.length > 50 || !companyName || companyName.length > 100) return { ok: false, reason: "invalid_input" };
  if (input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 200) return { ok: false, reason: "weak_password" };
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) return { ok: false, reason: "invalid_slug" };
  const planCode = input.planCode || DEFAULT_PLAN_CODE;
  if (!(SIGNUP_PLAN_CODES as readonly string[]).includes(planCode)) return { ok: false, reason: "invalid_input" };
  const businessNumber = normalizeBusinessNumber(input.businessNumber);
  if (!businessNumber) return { ok: false, reason: "invalid_business_number" };
  const openedOn = normalizeOpenedOn(input.openedOn ?? "");
  if (!openedOn) return { ok: false, reason: "invalid_input" };

  // 대표자 휴대폰 본인확인: 이 신청을 시작한 브라우저의 인증, 완료, 30분 안, 아직 안 쓴 것
  const v = await db.identityVerification.findUnique({ where: { id: input.verificationId } });
  const resumed = v ? await resumeApplication(db, v, input) : null;
  if (resumed) return resumed;
  if (
    !v ||
    v.purpose !== "SELLER_REPRESENTATIVE" ||
    v.sellerId !== null ||
    !input.ownerToken ||
    v.ownerTokenHash !== hashToken(input.ownerToken) ||
    v.consumedAt ||
    v.status !== "VERIFIED" ||
    !v.ciHash ||
    !v.verifiedAt ||
    !v.name ||
    v.expiresAt <= now ||
    now.getTime() - v.verifiedAt.getTime() > VERIFY_WINDOW_MS
  ) {
    return { ok: false, reason: "verification_invalid" };
  }
  const ciHash = v.ciHash;
  // 본인확인을 시작할 때 받은 필수 동의(없으면 신청을 받지 않는다, 화면은 약관 동의부터 다시)
  const consent = readSellerSignupConsent(v.signupConsent);
  if (!consent) return { ok: false, reason: "terms_required" };

  // 대표자 1명당 쇼핑몰 1개(해지·반려 제외). 어기면 신청 자체를 받지 않는다(DB 부분 유니크로도 막힘).
  const open = await db.seller.findFirst({ where: { representativeCiHash: ciHash, status: { notIn: ["CLOSED", "REJECTED"] } }, select: { id: true } });
  if (open) return { ok: false, reason: "representative_has_shop" };
  if (await db.seller.findUnique({ where: { slug }, select: { id: true } })) return { ok: false, reason: "slug_taken" };

  // 자동 점검: 걸린 항목은 「확인 필요」 사유가 된다
  const reasons: ReviewReason[] = [];
  // 국세청 진위확인: 사업자번호·대표자명(휴대폰 본인확인으로 확인한 이름)·개업일자 대조 + 계속사업자
  const nts = await providers.business.verify({ businessNumber, representativeName: v.name, openedOn });
  if (!nts.ok) reasons.push("business_lookup_failed");
  else {
    if (!nts.valid) reasons.push("business_info_mismatch");
    if (nts.status !== "ACTIVE") reasons.push("business_not_active");
  }
  // 공정위 통신판매업 신고 조회: 등록·사업자번호 일치·영업 정상
  const mailOrderNumber = input.mailOrderNumber ? normalizeMailOrderNumber(input.mailOrderNumber) : null;
  let mailOrderStatus: string | null = null;
  if (!mailOrderNumber) reasons.push("mail_order_number_invalid");
  else {
    const ftc = await providers.mailOrder.lookup({ businessNumber, mailOrderNumber });
    if (!ftc.ok) reasons.push("mail_order_lookup_failed");
    else if (!ftc.record || ftc.record.businessNumber !== businessNumber) reasons.push("mail_order_not_registered");
    else {
      mailOrderStatus = ftc.record.status;
      if (ftc.record.status !== "NORMAL") reasons.push("mail_order_not_active");
    }
  }

  const passwordHash = await hashPassword(input.password);
  try {
    const result = await db.$transaction(async (tx) => {
      const used = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null }, data: { consumedAt: now } });
      if (used.count !== 1) throw new Fail("verification_invalid");
      // 같은 사업자번호로 운영 중이거나 신청 중인 쇼핑몰이 있으면 자동 승인하지 않는다(번호별로 줄을 세워 동시 신청도 막음)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_bizno:${businessNumber}`}))`;
      const sameBusiness = await tx.seller.findFirst({
        where: { status: { notIn: ["CLOSED", "REJECTED"] }, businessInfo: { path: ["businessNumber"], equals: businessNumber } },
        select: { id: true },
      });
      if (sameBusiness) reasons.push("business_duplicate");
      const plan = await tx.subscriptionPlan.findUniqueOrThrow({ where: { code: planCode }, select: { id: true } });
      const seller = await tx.seller.create({
        data: {
          slug,
          shopName,
          status: "PENDING",
          planId: plan.id,
          representativeCiHash: ciHash,
          representativeVerifiedAt: v.verifiedAt,
          reviewReasons: reasons,
          businessInfo: {
            businessNumber,
            companyName,
            representativeName: v.name,
            openedOn,
            mailOrderNumber: mailOrderNumber ?? input.mailOrderNumber?.trim().slice(0, 100) ?? null,
            businessStatus: nts.ok ? nts.status : null,
            businessInfoValid: nts.ok ? nts.valid : null,
            mailOrderStatus,
            checkedAt: now.toISOString(),
          },
        },
      });
      await tx.memberGrade.createMany({
        data: [
          { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" },
          { sellerId: seller.id, displayName: "새싹", sortOrder: 1, systemKey: "SPROUT" },
          { sellerId: seller.id, displayName: "실버", sortOrder: 2, systemKey: "SILVER" },
          { sellerId: seller.id, displayName: "골드", sortOrder: 3, systemKey: "GOLD" },
          { sellerId: seller.id, displayName: "VIP", sortOrder: 4, systemKey: "VIP" },
        ],
      });
      const owner = await tx.sellerUser.create({
        data: { sellerId: seller.id, email, passwordHash, name: v.name!, isOwner: true, permissions: [], signupConsent: consent },
      });
      // 이 본인확인으로 만든 대표자 계정을 남긴다(응답이 끊겨 다시 보낸 요청을 알아보는 데 쓴다)
      await tx.identityVerification.update({ where: { id: v.id }, data: { subjectId: owner.id } });
      const audit = { sellerId: seller.id, targetType: "Seller", targetId: seller.id, ip: input.meta?.ip, userAgent: input.meta?.userAgent };
      await writeAudit(tx, { ...audit, actorType: "SELLER_USER", actorId: owner.id, action: "seller.apply", after: { reviewReasons: reasons, consent } });
      let approved = false;
      if (reasons.length === 0) {
        const row = await activateSeller(tx, seller.id, null);
        approved = !!row;
        await writeAudit(tx, { ...audit, actorType: "SYSTEM", action: "seller.auto_approve", after: { trialEndsAt: row?.trialEndsAt } });
      }
      return { sellerId: seller.id, approved };
    });
    return { ok: true, ...result, reviewReasons: reasons, resumed: false };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, reason: e.reason };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String(e.meta?.target ?? "");
      return { ok: false, reason: target.includes("slug") ? "slug_taken" : "representative_has_shop" };
    }
    // 부분 유니크(대표자 CI)는 Prisma가 일반 오류로 줄 수 있다
    if (String(e).includes("Seller_representativeCiHash_open_key")) return { ok: false, reason: "representative_has_shop" };
    throw e;
  }
}
