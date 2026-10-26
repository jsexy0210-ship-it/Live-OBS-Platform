import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { hashPassword, verifyPassword } from "../auth/password";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { generateToken, hashToken } from "../auth/token";
import { DEFAULT_PLAN_CODE, dbNow } from "../billing/subscription";
import { cleanText } from "../text/clean";
import { EMAIL, RESERVED_SLUGS, SLUG } from "./application";
import { createShopDefaults } from "./shopDefaults";
import { SIGNUP_PLAN_CODES } from "../billing/plans";
import { requestOrigin } from "../branding/siteUrl";

// 파트너스 직접 추가(마스터 최고관리자 전용, system.manage). 본인확인 계약 전 첫 파트너스를 열기 위한 임시 경로다.
// - 쇼핑몰을 바로 운영 중(ACTIVE)으로 만들고 대표자 계정은 로그인할 수 없는 난수 비밀번호로 둔다. 대표자는 초대 링크(72시간, 일회용)로 직접 비밀번호를 정한다.
// - 초대 토큰 원문은 만들 때 응답에 한 번만 주고 DB에는 SHA-256 해시만 둔다. 로그 추적·응답 외 어디에도 원문·링크를 남기지 않는다. 메일은 보내지 않는다.
// - 본인확인 대기 쇼핑몰이다(Seller.representativeVerifiedAt 없음): 제한은 identityGate.ts. 체험 종료일(trialEndsAt)은 명시한다(기본 7일, 상한 없음, 최고관리자만 정함).
export const INVITE_TTL_MS = 72 * 3_600_000;
export const DIRECT_TRIAL_DAYS = 7;
const DAY_MS = 86_400_000;
type Meta = { ip?: string | null; userAgent?: string | null };

export type DirectCreateInput = { shopName: unknown; slug: unknown; planCode?: unknown; ownerName: unknown; ownerEmail: unknown; reason: unknown; trialEndsAt?: unknown };
export type DirectCreateFailure = "invalid_input" | "invalid_slug" | "slug_taken" | "invalid_trial" | "invalid_reason";
export type ReissueFailure = "invalid_target" | "identity_verified";
export const DIRECT_CREATE_MESSAGES: Record<DirectCreateFailure | ReissueFailure | "invalid_invite" | "weak_password" | "service_ended", string> = {
  invalid_input: "쇼핑몰 이름·대표자 이름·이메일을 확인해 주십시오",
  invalid_slug: "쇼핑몰 주소는 영문 소문자·숫자·하이픈 3~30자로 입력해 주십시오",
  slug_taken: "이미 쓰는 쇼핑몰 주소입니다",
  invalid_trial: "체험 종료일은 지금보다 뒤의 날짜여야 합니다",
  invalid_reason: "사유를 1~200자로 입력해 주십시오",
  invalid_invite: "초대 링크가 올바르지 않거나 만료되었습니다. 최고관리자에게 새 링크를 요청해 주십시오",
  weak_password: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 입력해 주십시오`,
  invalid_target: "대상 쇼핑몰을 확인해 주십시오",
  identity_verified: "대표자 본인확인이 끝난 쇼핑몰은 초대 링크를 다시 만들 수 없습니다. 대표자 본인이 아이디·비밀번호 찾기를 쓰게 안내해 주십시오",
  service_ended: "이용이 종료된 쇼핑몰은 체험 기간을 늘릴 수 없습니다",
};

function requireSuper(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
}

// 초대 링크는 토큰을 URL 조각(#)에 둬서 서버 로그·Referer에 남지 않게 한다. 주소는 설정(OBS_SITE_ADDRESS, 호스트 이름일 때)을 우선한다.
// 설정이 없으면 운영은 요청 헤더(Host)를 믿지 않고 경로만 준다(화면이 마스터 관리자가 지금 보는 주소로 붙인다).
// 요청 주소로 만드는 것은 운영이 아닐 때(개발·시험)뿐이다. 하드코딩 주소는 없다.
export function inviteLink(token: string, headers: { get(name: string): string | null } | null): { path: string; url: string | null } {
  const path = `/seller/invite#${token}`;
  const configured = process.env.OBS_SITE_ADDRESS?.trim();
  if (configured && !configured.startsWith(":") && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(configured)) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured);
    return { path, url: `${local ? "http" : "https"}://${configured.toLowerCase()}${path}` };
  }
  const origin = headers && process.env.NODE_ENV !== "production" ? requestOrigin(headers) : null;
  return { path, url: origin ? `${origin.origin}${path}` : null };
}

export async function createSellerDirect(db: PrismaClient, admin: AdminSessionContext, raw: DirectCreateInput, meta: Meta = {}) {
  requireSuper(admin);
  const shopName = typeof raw.shopName === "string" ? raw.shopName.trim() : "";
  const ownerName = typeof raw.ownerName === "string" ? raw.ownerName.trim() : "";
  const email = typeof raw.ownerEmail === "string" ? raw.ownerEmail.trim().toLowerCase() : "";
  if (!shopName || shopName.length > 50 || /\p{C}/u.test(shopName) || !ownerName || [...ownerName].length > 30 || /\p{C}/u.test(ownerName) || !EMAIL.test(email)) return { ok: false as const, reason: "invalid_input" as const };
  const slug = typeof raw.slug === "string" ? raw.slug.trim().toLowerCase() : "";
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) return { ok: false as const, reason: "invalid_slug" as const };
  const reason = cleanText(raw.reason, 200, "memo");
  if (!reason) return { ok: false as const, reason: "invalid_reason" as const };
  const planCode = raw.planCode === undefined || raw.planCode === null ? DEFAULT_PLAN_CODE : raw.planCode;
  if (typeof planCode !== "string" || !(SIGNUP_PLAN_CODES as readonly string[]).includes(planCode)) return { ok: false as const, reason: "invalid_input" as const };
  const now = await dbNow(db);
  let trialEndsAt = new Date(now.getTime() + DIRECT_TRIAL_DAYS * DAY_MS);
  let trialCustom = false;
  if (raw.trialEndsAt !== undefined && raw.trialEndsAt !== null) {
    const t = typeof raw.trialEndsAt === "string" ? new Date(raw.trialEndsAt) : null;
    if (!t || Number.isNaN(t.getTime()) || t <= now) return { ok: false as const, reason: "invalid_trial" as const };
    trialEndsAt = t;
    trialCustom = true;
  }
  const passwordHash = await hashPassword(generateToken()); // 아무도 모르는 값: 초대 링크로 정하기 전에는 로그인할 수 없다
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  try {
    const result = await db.$transaction(async (tx) => {
      const plan = await tx.subscriptionPlan.findUniqueOrThrow({ where: { code: planCode }, select: { id: true } });
      const seller = await tx.seller.create({
        data: {
          slug, shopName, status: "ACTIVE", planId: plan.id, approvedAt: now, approvedByAdminId: admin.admin.id, trialEndsAt,
          directCreatedByAdminId: admin.admin.id, directCreatedAt: now,
          businessInfo: { representativeName: ownerName, directCreated: true },
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
      await createShopDefaults(tx, seller.id);
      const owner = await tx.sellerUser.create({ data: { sellerId: seller.id, email, passwordHash, name: ownerName, isOwner: true, permissions: [] } });
      const invite = await tx.sellerInvite.create({ data: { sellerId: seller.id, sellerUserId: owner.id, tokenHash: hashToken(token), expiresAt, createdByAdminId: admin.admin.id } });
      await writeAudit(tx, {
        actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId: seller.id, action: "admin.seller.direct_create", targetType: "Seller", targetId: seller.id,
        // 이메일·초대 링크·토큰은 남기지 않는다
        after: { slug, planCode, trialEndsAt, trialCustom, reason, inviteId: invite.id, inviteExpiresAt: expiresAt, identityPending: true },
        ip: meta.ip, userAgent: meta.userAgent,
      });
      return { sellerId: seller.id, ownerUserId: owner.id };
    });
    return { ok: true as const, ...result, trialEndsAt, inviteToken: token, inviteExpiresAt: expiresAt };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false as const, reason: "slug_taken" as const };
    throw e;
  }
}

// 초대 다시 만들기: 직접 추가한 쇼핑몰의 대표자에게만. 이전 미사용 초대는 모두 무효가 된다(링크 분실·유출 복구, 셀프 비밀번호 찾기를 못 쓰는 대표자의 복구 경로).
export async function reissueInvite(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  requireSuper(admin);
  if (!/^[0-9a-f-]{36}$/i.test(sellerId)) return { ok: false as const, reason: "invalid_target" as const };
  const now = await dbNow(db);
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  return db.$transaction(async (tx) => {
    const seller = await tx.seller.findUnique({ where: { id: sellerId }, select: { id: true, status: true, directCreatedByAdminId: true, representativeVerifiedAt: true } });
    if (!seller || !seller.directCreatedByAdminId || seller.status === "CLOSED") return { ok: false as const, reason: "invalid_target" as const };
    // 본인확인이 끝난 계정은 대표자 본인의 인증으로만 복구한다: 관리자가 초대로 비밀번호를 바꾸고 세션을 끊는 경로를 열어 두지 않는다
    if (seller.representativeVerifiedAt) return { ok: false as const, reason: "identity_verified" as const };
    const owner = await tx.sellerUser.findFirst({ where: { sellerId, isOwner: true, status: "ACTIVE" }, select: { id: true } });
    if (!owner) return { ok: false as const, reason: "invalid_target" as const };
    const revoked = await tx.sellerInvite.updateMany({ where: { sellerUserId: owner.id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    const invite = await tx.sellerInvite.create({ data: { sellerId, sellerUserId: owner.id, tokenHash: hashToken(token), expiresAt, createdByAdminId: admin.admin.id } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.invite_reissue", targetType: "Seller", targetId: sellerId,
      after: { inviteId: invite.id, inviteExpiresAt: expiresAt, revokedInvites: revoked.count }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return { ok: true as const, inviteToken: token, inviteExpiresAt: expiresAt, revokedInvites: revoked.count };
  });
}

// 초대로 비밀번호 정하기(공개 경로, 로그인 전). 무효·만료·사용됨·무효화는 모두 같은 invalid_invite로 답한다.
// 성공하면 토큰을 소진하고 대표자 비밀번호를 정하며 그 계정의 기존 세션을 끊는다. 같은 비밀번호로 10분 안에 다시 보내면(응답 유실) 성공으로 답한다.
export async function acceptInvite(db: PrismaClient, input: { token: unknown; newPassword: unknown }, meta: Meta = {}) {
  if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 200 || typeof input.newPassword !== "string" || input.newPassword.length > 200) return { ok: false as const, reason: "invalid_invite" as const };
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) return { ok: false as const, reason: "weak_password" as const };
  const tokenHash = hashToken(input.token);
  const now = await dbNow(db);
  const inv = await db.sellerInvite.findUnique({ where: { tokenHash }, include: { sellerUser: { select: { id: true, status: true, passwordHash: true } }, seller: { select: { slug: true, status: true, representativeVerifiedAt: true } } } });
  if (!inv || inv.revokedAt || inv.sellerUser.status !== "ACTIVE" || ["CLOSED", "REJECTED"].includes(inv.seller.status)) return { ok: false as const, reason: "invalid_invite" as const };
  // 초대를 받은 뒤 본인확인이 끝났다면 남은 초대로는 비밀번호를 바꿀 수 없다(재발급 거절과 같은 이유)
  if (inv.seller.representativeVerifiedAt && !inv.usedAt) return { ok: false as const, reason: "invalid_invite" as const };
  if (inv.usedAt) {
    const retry = now.getTime() - inv.usedAt.getTime() <= 10 * 60_000 && (await verifyPassword(inv.sellerUser.passwordHash, input.newPassword));
    return retry ? { ok: true as const, shopSlug: inv.seller.slug } : { ok: false as const, reason: "invalid_invite" as const };
  }
  if (inv.expiresAt <= now) return { ok: false as const, reason: "invalid_invite" as const };
  const passwordHash = await hashPassword(input.newPassword);
  const done = await db.$transaction(async (tx) => {
    const used = await tx.sellerInvite.updateMany({ where: { id: inv.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return false;
    await tx.sellerUser.update({ where: { id: inv.sellerUserId }, data: { passwordHash, credentialVersion: { increment: 1 } } });
    const sessions = await tx.sellerSession.updateMany({ where: { sellerUserId: inv.sellerUserId, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, {
      actorType: "SELLER_USER", actorId: inv.sellerUserId, sellerId: inv.sellerId, action: "auth.seller.invite_accept", targetType: "SellerUser", targetId: inv.sellerUserId,
      after: { inviteId: inv.id, revokedSessions: sessions.count }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return true;
  });
  return done ? { ok: true as const, shopSlug: inv.seller.slug } : { ok: false as const, reason: "invalid_invite" as const };
}

// 체험 종료일 바꾸기(연장·단축): 최고관리자만, 상한 없음, 지금보다 뒤 날짜만, 전후와 사유를 로그 추적에 남긴다. 이미 자동 해지(serviceEndedAt)된 쇼핑몰은 대상이 아니다.
export async function setTrialEnd(db: PrismaClient, admin: AdminSessionContext, sellerId: string, input: { trialEndsAt: unknown; reason: unknown }, meta: Meta = {}) {
  requireSuper(admin);
  if (!/^[0-9a-f-]{36}$/i.test(sellerId)) return { ok: false as const, reason: "invalid_target" as const };
  const reason = cleanText(input.reason, 200, "memo");
  if (!reason) return { ok: false as const, reason: "invalid_reason" as const };
  const now = await dbNow(db);
  const t = typeof input.trialEndsAt === "string" ? new Date(input.trialEndsAt) : null;
  if (!t || Number.isNaN(t.getTime()) || t <= now) return { ok: false as const, reason: "invalid_trial" as const };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
    const s = await tx.seller.findUnique({ where: { id: sellerId }, select: { status: true, trialEndsAt: true, serviceEndedAt: true } });
    if (!s || !["ACTIVE", "SUSPENDED"].includes(s.status)) return { ok: false as const, reason: "invalid_target" as const };
    if (s.serviceEndedAt) return { ok: false as const, reason: "service_ended" as const };
    await tx.seller.update({ where: { id: sellerId }, data: { trialEndsAt: t } });
    // 체험 중 카드를 등록했다면 첫 결제 시각(nextChargeAt)이 옛 체험 종료일로 저장돼 있다(registerCardAndPay). 같이 옮기지 않으면 연장해도 옛 날짜에 결제된다.
    // 옛 체험 종료일과 정확히 같은 ACTIVE 구독의 nextChargeAt만 옮긴다: 결제한 기간의 갱신 일정(기간 끝 − 여유)은 건드리지 않는다.
    let chargeMoved = 0;
    if (s.trialEndsAt) {
      const moved = await tx.sellerSubscription.updateMany({ where: { sellerId, status: "ACTIVE", cancelAtPeriodEnd: false, nextChargeAt: s.trialEndsAt }, data: { nextChargeAt: t } });
      chargeMoved = moved.count;
    }
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.trial_set", targetType: "Seller", targetId: sellerId,
      before: { trialEndsAt: s.trialEndsAt }, after: { trialEndsAt: t, reason, firstChargeMoved: chargeMoved > 0 }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return { ok: true as const, trialEndsAt: t, previous: s.trialEndsAt, firstChargeMoved: chargeMoved > 0 };
  });
}
