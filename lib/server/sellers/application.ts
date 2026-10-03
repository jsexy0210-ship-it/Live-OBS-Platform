import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { normalizeEmail } from "../auth/login";
import { hashPassword } from "../auth/password";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { hashToken } from "../auth/token";
import type { IdentityProvider } from "../identity/provider";
import { parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import { activateSeller } from "./approval";
import {
  normalizeBusinessNumber,
  normalizeMailOrderNumber,
  normalizeOpenedOn,
  type BusinessStatusProvider,
  type MailOrderProvider,
} from "./businessCheck";

// 판매자 가입 신청과 자동 점검(대표님 결정 2026-10-02, PRODUCT_SCOPE 「판매자 가입 자동 승인」).
// 점검: 대표자 휴대폰 본인확인(필수) · 대표자 CI 중복(1인 1쇼핑몰) · 국세청 진위확인(대표자명·개업일 대조)·「계속사업자」 ·
// 같은 사업자번호로 운영·신청 중인 쇼핑몰 없음 · 통신판매업 신고 조회(공정위, 등록·사업자번호 일치·영업 정상).
// 모두 통과하면 바로 승인(체험하기 시작), 하나라도 걸리면 승인 대기로 두고 걸린 항목을 「확인 필요」 사유로 남긴다.
// 로그인 이메일·비밀번호는 신청자가 정한다.

const VERIFY_WINDOW_MS = 30 * 60_000;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_SLUGS = new Set(["admin", "api", "app", "www", "master", "seller", "shop", "static", "help", "support", "login", "signup", "overlay"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// 가입용 휴대폰 본인확인은 건당 비용이 들어 같은 접속 IP에서 하루(KST 자정 초기화) 10회까지만 시작한다(MASTER 결정 2026-10-03).
export const SIGNUP_VERIFY_DAILY_LIMIT_PER_IP = 10;

// 대표자 1인 1쇼핑몰 위반 때 보여 줄 문구(다른 쇼핑몰 이름은 보여 주지 않음, MASTER 결정)
export const REPRESENTATIVE_HAS_SHOP_MESSAGE = "이미 운영 중인 쇼핑몰이 있어요 · 한 대표자는 쇼핑몰 하나만 열 수 있어요";

// 판매자 가입 휴대폰 본인확인 시작(인적사항 검사 → 요청 기록 → 첫 인증번호). IP별로 줄을 세워(advisory lock) 오늘(KST) 시작 건수를 DB 시계로 센 뒤 한도 안일 때만 시작한다.
// IP를 알 수 없으면(신뢰 프록시 미설정) 하나의 묶음으로 센다.
export async function startSellerSignupVerification(
  db: PrismaClient,
  provider: IdentityProvider,
  rawPerson: unknown,
  meta: { ip?: string | null; userAgent?: string | null; now?: Date } = {},
) {
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false as const, reason: "invalid_identity_input" as const };
  const ip = meta.ip ?? null;
  const started = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_signup:${ip ?? "unknown"}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'SELLER_REPRESENTATIVE'
        AND "requestIp" IS NOT DISTINCT FROM ${ip}
        AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= SIGNUP_VERIFY_DAILY_LIMIT_PER_IP) return null;
    return startIdentityVerification(tx, provider, { purpose: "SELLER_REPRESENTATIVE", sellerId: null, person, requestIp: ip, now: meta.now });
  });
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
  | "representative_has_shop";

export type ApplyResult = { ok: true; sellerId: string; approved: boolean; reviewReasons: ReviewReason[] } | { ok: false; reason: ApplyFailure };

class Fail extends Error {
  constructor(readonly reason: ApplyFailure) {
    super(reason);
  }
}

export async function applyForSeller(
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
  const businessNumber = normalizeBusinessNumber(input.businessNumber);
  if (!businessNumber) return { ok: false, reason: "invalid_business_number" };
  const openedOn = normalizeOpenedOn(input.openedOn ?? "");
  if (!openedOn) return { ok: false, reason: "invalid_input" };

  // 대표자 휴대폰 본인확인: 이 신청을 시작한 브라우저의 인증, 완료, 30분 안, 아직 안 쓴 것
  const v = await db.identityVerification.findUnique({ where: { id: input.verificationId } });
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
      const seller = await tx.seller.create({
        data: {
          slug,
          shopName,
          status: "PENDING",
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
        data: { sellerId: seller.id, email, passwordHash, name: v.name!, isOwner: true, permissions: [] },
      });
      const audit = { sellerId: seller.id, targetType: "Seller", targetId: seller.id, ip: input.meta?.ip, userAgent: input.meta?.userAgent };
      await writeAudit(tx, { ...audit, actorType: "SELLER_USER", actorId: owner.id, action: "seller.apply", after: { reviewReasons: reasons } });
      let approved = false;
      if (reasons.length === 0) {
        const row = await activateSeller(tx, seller.id, null);
        approved = !!row;
        await writeAudit(tx, { ...audit, actorType: "SYSTEM", action: "seller.auto_approve", after: { trialEndsAt: row?.trialEndsAt } });
      }
      return { sellerId: seller.id, approved };
    });
    return { ok: true, ...result, reviewReasons: reasons };
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
