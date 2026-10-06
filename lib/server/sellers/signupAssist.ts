import type { IdentityVerification, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { hashToken } from "../auth/token";
import { licenseSummaryOf, type LicenseSummary } from "./businessLicense";
import { RESERVED_SLUGS, SLUG, VERIFY_WINDOW_MS } from "./application";
import {
  normalizeBusinessNumber,
  normalizeMailOrderNumber,
  normalizeOpenedOn,
  type BusinessStatus,
  type BusinessStatusProvider,
  type MailOrderProvider,
} from "./businessCheck";

// 파트너스 가입 신청 화면(PF-007-3~5)을 돕는 조회: 쇼핑몰 주소 확인 · 사업자·통신판매업 조회 · 신청 상태 보기.
// 본인확인을 마친 브라우저(흐름 쿠키)만 쓸 수 있다. 신청을 만들지 않으며 대표자 계정·쇼핑몰도 바꾸지 않는다.

// 본인확인(완료·30분 안·아직 안 쓴 것)이 이 브라우저의 것인지. 맞으면 그 기록
export async function ownedVerification(db: PrismaClient, verificationId: string, ownerToken: string | undefined, now = new Date()): Promise<IdentityVerification | null> {
  if (!ownerToken) return null;
  const v = await db.identityVerification.findUnique({ where: { id: verificationId } });
  if (
    !v ||
    v.purpose !== "SELLER_REPRESENTATIVE" ||
    v.sellerId !== null ||
    v.ownerTokenHash !== hashToken(ownerToken) ||
    v.consumedAt ||
    v.status !== "VERIFIED" ||
    !v.verifiedAt ||
    v.expiresAt <= now ||
    now.getTime() - v.verifiedAt.getTime() > VERIFY_WINDOW_MS
  ) {
    return null;
  }
  return v;
}

// 쇼핑몰 주소(slug) 사용 가능 여부. 형식·예약어가 틀리면 invalid, 이미 쓰는 주소면 taken
export async function checkSlug(db: PrismaClient, rawSlug: string): Promise<{ available: boolean; reason: "invalid" | "taken" | null }> {
  const slug = rawSlug.trim().toLowerCase();
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) return { available: false, reason: "invalid" };
  const taken = await db.seller.findUnique({ where: { slug }, select: { id: true } });
  return taken ? { available: false, reason: "taken" } : { available: true, reason: null };
}

// 한 본인확인으로 조회할 수 있는 횟수(국세청·공정위 조회는 무료 한도가 있어 넘기지 못하게 막는다)
export const BUSINESS_CHECK_LIMIT = 10;
const CHECK_ACTION = "seller.signup.business_check";

export type BusinessCheckResult =
  | { ok: false; reason: "limit_exceeded" | "invalid_business_number" | "invalid_opened_on" }
  | {
      ok: true;
      // 국세청: lookup=false면 조회를 못 한 것(신청은 받고 확인 필요로 간다). valid=대표자·개업일 일치, status=영업 상태
      business: { lookup: boolean; valid: boolean | null; status: BusinessStatus | null };
      // 같은 사업자번호로 운영·신청 중인 쇼핑몰이 있는지(어느 쇼핑몰인지는 알려 주지 않는다)
      duplicate: boolean;
      // 통신판매업: 신고번호를 보냈을 때만. state는 정상·미등록·영업 아님·조회 실패·형식 오류
      mailOrder: { state: "NORMAL" | "NOT_REGISTERED" | "NOT_ACTIVE" | "LOOKUP_FAILED" | "INVALID_NUMBER" } | null;
    };

export async function checkSignupBusiness(
  db: PrismaClient,
  providers: { business: BusinessStatusProvider; mailOrder: MailOrderProvider },
  v: IdentityVerification,
  input: { businessNumber: string; openedOn: string; mailOrderNumber?: string | null },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<BusinessCheckResult> {
  const businessNumber = normalizeBusinessNumber(input.businessNumber);
  if (!businessNumber) return { ok: false, reason: "invalid_business_number" };
  const openedOn = normalizeOpenedOn(input.openedOn);
  if (!openedOn) return { ok: false, reason: "invalid_opened_on" };
  const used = await db.auditLog.count({ where: { action: CHECK_ACTION, targetType: "IdentityVerification", targetId: v.id } });
  if (used >= BUSINESS_CHECK_LIMIT) return { ok: false, reason: "limit_exceeded" };
  await writeAudit(db, { actorType: "SYSTEM", action: CHECK_ACTION, targetType: "IdentityVerification", targetId: v.id, ip: meta.ip, userAgent: meta.userAgent });

  const nts = await providers.business.verify({ businessNumber, representativeName: v.name ?? "", openedOn });
  const business = nts.ok ? { lookup: true, valid: nts.valid, status: nts.status } : { lookup: false, valid: null, status: null };
  const duplicate = !!(await db.seller.findFirst({
    where: { status: { notIn: ["CLOSED", "REJECTED"] }, businessInfo: { path: ["businessNumber"], equals: businessNumber } },
    select: { id: true },
  }));
  let mailOrder: Extract<BusinessCheckResult, { ok: true }>["mailOrder"] = null;
  if (input.mailOrderNumber?.trim()) {
    const number = normalizeMailOrderNumber(input.mailOrderNumber);
    if (!number) mailOrder = { state: "INVALID_NUMBER" };
    else {
      const ftc = await providers.mailOrder.lookup({ businessNumber, mailOrderNumber: number });
      mailOrder = {
        state: !ftc.ok ? "LOOKUP_FAILED" : !ftc.record || ftc.record.businessNumber !== businessNumber ? "NOT_REGISTERED" : ftc.record.status !== "NORMAL" ? "NOT_ACTIVE" : "NORMAL",
      };
    }
  }
  return { ok: true, business, duplicate, mailOrder };
}

export type ApplicationState = "APPROVED" | "PENDING" | "SUPPLEMENT" | "REJECTED";
export type ApplicationStatus = {
  state: ApplicationState;
  receivedAt: string;
  // 사업자등록증을 올렸다면 그 요약(보기 링크는 마스터 전용이라 신청자에게는 주지 않는다)
  license: LicenseSummary | null;
};

// 신청 상태 보기(PF-007-5): 신청을 마친 이 브라우저(흐름 쿠키)로 신청한 쇼핑몰의 지금 상태. 이유·보완 사유는 로그인 전이라 내용을 주지 않고 상태만 준다.
export async function signupApplicationStatus(db: PrismaClient, verificationId: string, ownerToken: string | undefined): Promise<ApplicationStatus | null> {
  if (!ownerToken) return null;
  const v = await db.identityVerification.findUnique({ where: { id: verificationId } });
  if (!v || v.purpose !== "SELLER_REPRESENTATIVE" || v.sellerId !== null || !v.consumedAt || !v.subjectId || v.ownerTokenHash !== hashToken(ownerToken)) return null;
  const owner = await db.sellerUser.findUnique({
    where: { id: v.subjectId },
    select: { isOwner: true, seller: { select: { id: true, status: true, createdAt: true } } },
  });
  if (!owner?.isOwner) return null;
  const { seller } = owner;
  const rev = await db.sellerApplicationReview.findUnique({ where: { sellerId: seller.id }, select: { supplementRequestedAt: true, supplementResolvedAt: true } });
  const state: ApplicationState =
    seller.status === "REJECTED" || seller.status === "CLOSED"
      ? "REJECTED"
      : seller.status !== "PENDING"
        ? "APPROVED"
        : rev?.supplementRequestedAt && !rev.supplementResolvedAt
          ? "SUPPLEMENT"
          : "PENDING";
  return { state, receivedAt: seller.createdAt.toISOString(), license: await licenseSummaryOf(db, seller.id) };
}
