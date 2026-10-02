import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { burnPasswordCheck, verifyPassword } from "./password";
import { isLocked, nextLockStateAfterFailure, type LockState } from "./policy";
import { open } from "./secretBox";
import { createAdminSession, createBuyerSession, createSellerSession, type IssuedSession, type SessionMeta } from "./session";
import { verifyTotp } from "./totp";

export type LoginFailure =
  | "invalid_credentials"
  | "locked"
  | "mfa_required"
  | "account_disabled"
  | "seller_pending"
  | "seller_suspended"
  | "seller_closed"
  | "shop_required"
  | "dormant";

export type LoginResult = ({ ok: true } & IssuedSession) | { ok: false; reason: LoginFailure };

const fail = (reason: LoginFailure): LoginResult => ({ ok: false, reason });

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

type LockTarget = LockState & { id: string };
type LockUpdater = (id: string, data: LockState) => Promise<unknown>;

// 비밀번호(또는 2단계 인증) 실패 1회 반영. 5회째면 잠그고 true를 돌려준다.
async function recordFailure(target: LockTarget, now: Date, update: LockUpdater): Promise<boolean> {
  const next = nextLockStateAfterFailure(target, now);
  await update(target.id, { failedLoginCount: next.failedLoginCount, lockedUntil: next.lockedUntil });
  return next.lockedNow;
}

// ───────────── 마스터 ─────────────

export async function loginAdmin(
  db: PrismaClient,
  input: { email: string; password: string; totpCode?: string },
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
  if (isLocked(admin, now)) {
    await audit("auth.admin.login_blocked", admin.id, "locked");
    return fail("locked");
  }

  let ok = await verifyPassword(admin.passwordHash, input.password);
  const mfaEnabled = !!admin.totpEnabledAt && !!admin.totpSecretEnc;
  if (ok && mfaEnabled) {
    if (!input.totpCode) return fail("mfa_required");
    ok = verifyTotp(open(admin.totpSecretEnc!), input.totpCode, now);
  }
  if (!ok) {
    const lockedNow = await recordFailure(admin, now, (id, data) => db.platformAdmin.update({ where: { id }, data }));
    await audit(lockedNow ? "auth.admin.locked" : "auth.admin.login_failed", admin.id);
    return fail(lockedNow ? "locked" : "invalid_credentials");
  }
  if (admin.status !== "ACTIVE") {
    await audit("auth.admin.login_blocked", admin.id, "suspended");
    return fail("account_disabled");
  }

  await db.platformAdmin.update({
    where: { id: admin.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  });
  const session = await createAdminSession(db, admin.id, mfaEnabled, { ...meta, now });
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
  const email = normalizeEmail(input.email);
  const candidates = await db.sellerUser.findMany({
    where: { email, ...(input.shopSlug ? { seller: { slug: input.shopSlug } } : {}) },
    include: { seller: true },
  });
  const audit = (action: string, actorId: string | null, sellerId: string | null, reason?: string) =>
    writeAudit(db, { actorType: "SELLER_USER", actorId, sellerId, action, reason, ip: meta.ip, userAgent: meta.userAgent });
  const updateLock: LockUpdater = (id, data) => db.sellerUser.update({ where: { id }, data });

  if (candidates.length === 0) {
    await burnPasswordCheck(input.password);
    await audit("auth.seller.login_failed", null, null, "unknown_account");
    return fail("invalid_credentials");
  }

  // 같은 이메일로 여러 판매자 계정이 있으면(판매자별 별도 계정) 비밀번호가 맞는 계정을 찾는다.
  const open_ = candidates.filter((u) => !isLocked(u, now));
  if (open_.length === 0) {
    for (const u of candidates) await audit("auth.seller.login_blocked", u.id, u.sellerId, "locked");
    return fail("locked");
  }
  const matched = [];
  for (const u of open_) if (await verifyPassword(u.passwordHash, input.password)) matched.push(u);

  if (matched.length === 0) {
    let anyLocked = false;
    for (const u of open_) {
      const lockedNow = await recordFailure(u, now, updateLock);
      anyLocked ||= lockedNow;
      await audit(lockedNow ? "auth.seller.locked" : "auth.seller.login_failed", u.id, u.sellerId);
    }
    return fail(anyLocked && open_.length === 1 ? "locked" : "invalid_credentials");
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

  await db.sellerUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
  const session = await createSellerSession(db, user.sellerId, user.id, { ...meta, now });
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
    where: { sellerId: input.sellerId, loginId: input.loginId.trim(), deletedAt: null },
  });
  if (!member) {
    await burnPasswordCheck(input.password);
    await audit("auth.buyer.login_failed", null, "unknown_account");
    return fail("invalid_credentials");
  }
  if (isLocked(member, now)) {
    await audit("auth.buyer.login_blocked", member.id, "locked");
    return fail("locked");
  }
  if (!(await verifyPassword(member.passwordHash, input.password))) {
    const lockedNow = await recordFailure(member, now, (id, data) => db.buyerMember.update({ where: { id }, data }));
    await audit(lockedNow ? "auth.buyer.locked" : "auth.buyer.login_failed", member.id);
    return fail(lockedNow ? "locked" : "invalid_credentials");
  }
  if (member.status === "DORMANT") return fail("dormant");
  if (member.status !== "ACTIVE") return fail("account_disabled");

  await db.buyerMember.update({ where: { id: member.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
  const session = await createBuyerSession(db, input.sellerId, member.id, { ...meta, now });
  await audit("auth.buyer.login", member.id);
  return { ok: true, ...session };
}
