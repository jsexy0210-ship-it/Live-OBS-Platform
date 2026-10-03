import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { burnPasswordCheck, verifyPassword } from "./password";
import { createAdminSession, createBuyerSession, createSellerSession, type IssuedSession, type SessionMeta } from "./session";

// 로그인은 아이디(이메일)와 비밀번호만 확인한다. 실패 잠금·IP 제한·2단계 인증은 두지 않고(대표님 결정 2026-10-02),
// 성공·실패는 모두 감사 로그에 남긴다(IP는 신뢰 프록시 기준).

export type LoginFailure =
  | "invalid_credentials"
  | "account_disabled"
  | "seller_pending"
  | "seller_suspended"
  | "seller_closed"
  | "shop_required"
  | "dormant";

export type LoginResult = ({ ok: true } & IssuedSession) | { ok: false; reason: LoginFailure };

const fail = (reason: LoginFailure): LoginResult => ({ ok: false, reason });

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
// 이메일 아이디 길이 상한(RFC 5321 경로 길이). 구매자 가입·로그인이 같은 기준을 쓴다.
export const MAX_EMAIL_LENGTH = 254;
export const isEmailLengthOk = (v: unknown): v is string => typeof v === "string" && normalizeEmail(v).length > 0 && normalizeEmail(v).length <= MAX_EMAIL_LENGTH;

// ───────────── 마스터 ─────────────

export async function loginAdmin(
  db: PrismaClient,
  input: { email: string; password: string },
  meta: SessionMeta,
): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const audit = (action: string, actorId: string | null, reason?: string) =>
    writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId, action, reason, ip: meta.ip, userAgent: meta.userAgent });

  const admin = await db.platformAdmin.findUnique({ where: { email: normalizeEmail(input.email) } });
  if (!admin) {
    await burnPasswordCheck(input.password);
    await audit("auth.admin.login_failed", null, "unknown_account");
    return fail("invalid_credentials");
  }
  if (!(await verifyPassword(admin.passwordHash, input.password))) {
    await audit("auth.admin.login_failed", admin.id, "wrong_password");
    return fail("invalid_credentials");
  }
  if (admin.status !== "ACTIVE") {
    await audit("auth.admin.login_blocked", admin.id, "suspended");
    return fail("account_disabled");
  }

  await db.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
  const session = await createAdminSession(db, admin.id, { ...meta, now });
  await audit("auth.admin.login", admin.id);
  return { ok: true, ...session };
}

// ───────────── 판매자 (대표·직원) ─────────────

export async function loginSeller(
  db: PrismaClient,
  input: { email: string; password: string; shopSlug?: string },
  meta: SessionMeta,
): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const audit = (action: string, actorId: string | null, sellerId: string | null, reason?: string) =>
    writeAudit(db, { actorType: "SELLER_USER", actorId, sellerId, action, reason, ip: meta.ip, userAgent: meta.userAgent });

  const candidates = await db.sellerUser.findMany({
    where: { email: normalizeEmail(input.email), ...(input.shopSlug ? { seller: { slug: input.shopSlug } } : {}) },
    include: { seller: true },
  });
  if (candidates.length === 0) {
    await burnPasswordCheck(input.password);
    await audit("auth.seller.login_failed", null, null, "unknown_account");
    return fail("invalid_credentials");
  }

  // 같은 이메일로 여러 판매자 계정이 있으면(판매자별 별도 계정) 비밀번호가 맞는 계정을 찾는다.
  const matched = [];
  for (const u of candidates) if (await verifyPassword(u.passwordHash, input.password)) matched.push(u);
  if (matched.length === 0) {
    // 계정이 하나로 정해질 때만 그 계정의 실패로 기록한다. 쇼핑몰이 특정되지 않으면 계정 없이 남긴다.
    const only = candidates.length === 1 ? candidates[0] : null;
    await audit("auth.seller.login_failed", only?.id ?? null, only?.sellerId ?? null, only ? "wrong_password" : "shop_unspecified");
    return fail("invalid_credentials");
  }
  if (matched.length > 1) return fail("shop_required");

  const user = matched[0];
  if (user.status !== "ACTIVE") {
    await audit("auth.seller.login_blocked", user.id, user.sellerId, "account_disabled");
    return fail("account_disabled");
  }
  const sellerBlock: Partial<Record<string, LoginFailure>> = {
    PENDING: "seller_pending",
    SUSPENDED: "seller_suspended",
    REJECTED: "seller_closed",
    CLOSED: "seller_closed",
  };
  const blocked = sellerBlock[user.seller.status];
  if (blocked) {
    await audit("auth.seller.login_blocked", user.id, user.sellerId, blocked);
    return fail(blocked);
  }

  await db.sellerUser.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  // 비밀번호를 확인한 시점의 자격 버전으로 세션을 만든다. 그사이 재설정되면 이 세션은 바로 무효다.
  const session = await createSellerSession(db, user.sellerId, user.id, { ...meta, now }, user.credentialVersion);
  await audit("auth.seller.login", user.id, user.sellerId);
  return { ok: true, ...session };
}

// ───────────── 구매자 (쇼핑몰별) ─────────────

export async function loginBuyer(
  db: PrismaClient,
  input: { sellerId: string; loginId: string; password: string },
  meta: SessionMeta,
): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const audit = (action: string, actorId: string | null, reason?: string) =>
    writeAudit(db, {
      actorType: "BUYER",
      actorId,
      sellerId: input.sellerId,
      action,
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

  const member = await db.buyerMember.findFirst({
    // 구매자 아이디는 이메일이라 가입 때처럼 소문자로 맞춰 찾는다
    where: { sellerId: input.sellerId, loginId: normalizeEmail(input.loginId), deletedAt: null },
  });
  if (!member) {
    await burnPasswordCheck(input.password);
    await audit("auth.buyer.login_failed", null, "unknown_account");
    return fail("invalid_credentials");
  }
  if (!(await verifyPassword(member.passwordHash, input.password))) {
    await audit("auth.buyer.login_failed", member.id, "wrong_password");
    return fail("invalid_credentials");
  }
  if (member.status === "DORMANT") return fail("dormant");
  if (member.status !== "ACTIVE") return fail("account_disabled");

  await db.buyerMember.update({ where: { id: member.id }, data: { lastLoginAt: now } });
  const session = await createBuyerSession(db, input.sellerId, member.id, { ...meta, now });
  await audit("auth.buyer.login", member.id);
  return { ok: true, ...session };
}
