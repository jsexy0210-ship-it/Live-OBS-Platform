import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { isIpBlocked, recordAccountFailure, recordAccountSuccess, recordIpFailure } from "./lockout";
import { burnPasswordCheck, verifyPassword } from "./password";
import { isLocked, type Realm } from "./policy";
import { open } from "./secretBox";
import { createAdminSession, createBuyerSession, createSellerSession, type IssuedSession, type SessionMeta } from "./session";
import { matchTotpCounter } from "./totp";

export type LoginFailure =
  | "invalid_credentials"
  | "locked"
  | "account_disabled"
  | "seller_pending"
  | "seller_suspended"
  | "seller_closed"
  | "shop_required"
  | "dormant";

// mfaEnrollmentRequired: TOTP를 아직 등록하지 않은 마스터. 등록 API만 쓸 수 있는 제한 세션이다.
export type LoginResult =
  | ({ ok: true; mfaEnrollmentRequired?: boolean } & IssuedSession)
  | { ok: false; reason: LoginFailure };

const fail = (reason: LoginFailure): LoginResult => ({ ok: false, reason });

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// IP 기준 차단(계정과 별개). 막혀 있으면 계정 확인 없이 거부한다.
async function ipGate(db: PrismaClient, realm: Realm, meta: SessionMeta, now: Date, audit: (a: string, r?: string) => Promise<void>) {
  if (await isIpBlocked(db, realm, meta.ip, now)) {
    await audit(`auth.${realm}.login_blocked`, "ip_locked");
    return true;
  }
  return false;
}

// ───────────── 마스터 ─────────────

// 2단계 인증을 등록한 마스터는 비밀번호와 코드를 함께 보내야 한다. 코드가 없거나 틀리거나 이미 쓴 코드면
// 비밀번호가 틀린 것과 같은 응답을 주고 실패 횟수에 넣는다(비밀번호가 맞았는지 드러나지 않게).
export async function loginAdmin(
  db: PrismaClient,
  input: { email: string; password: string; totpCode?: string },
  meta: SessionMeta,
): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const audit = async (action: string, actorId: string | null, reason?: string) =>
    writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId, action, reason, ip: meta.ip, userAgent: meta.userAgent });
  if (await ipGate(db, "admin", meta, now, (a, r) => audit(a, null, r))) return fail("locked");

  const failed = async (adminId: string | null) => {
    const ipLocked = await recordIpFailure(db, "admin", meta.ip, now);
    const accountLocked = adminId ? await recordAccountFailure(db, "PlatformAdmin", adminId, now) : false;
    await audit(accountLocked ? "auth.admin.locked" : "auth.admin.login_failed", adminId);
    return fail(accountLocked || ipLocked ? "locked" : "invalid_credentials");
  };

  const admin = await db.platformAdmin.findUnique({ where: { email: normalizeEmail(input.email) } });
  if (!admin) {
    await burnPasswordCheck(input.password);
    return failed(null);
  }
  if (isLocked(admin, now)) {
    await audit("auth.admin.login_blocked", admin.id, "locked");
    return fail("locked");
  }

  const enrolled = !!admin.totpEnabledAt && !!admin.totpSecretEnc;
  let ok = await verifyPassword(admin.passwordHash, input.password);
  let counter: number | null = null;
  if (ok && enrolled) {
    counter = matchTotpCounter(open(admin.totpSecretEnc!), input.totpCode ?? "", now);
    ok = counter !== null && (admin.lastTotpCounter === null || counter > admin.lastTotpCounter);
  }
  if (!ok) return failed(admin.id);
  if (admin.status !== "ACTIVE") {
    await audit("auth.admin.login_blocked", admin.id, "suspended");
    return fail("account_disabled");
  }
  if (enrolled) {
    // 같은 코드를 동시에 두 번 써도 한 번만 통과한다.
    const consumed = await db.platformAdmin.updateMany({
      where: { id: admin.id, OR: [{ lastTotpCounter: null }, { lastTotpCounter: { lt: counter! } }] },
      data: { lastTotpCounter: counter! },
    });
    if (consumed.count === 0) return failed(admin.id);
  }
  if (!(await recordAccountSuccess(db, "PlatformAdmin", admin.id, now))) return fail("locked");

  const session = await createAdminSession(db, admin.id, { mfaVerified: enrolled, enrollmentOnly: !enrolled }, { ...meta, now });
  await audit(enrolled ? "auth.admin.login" : "auth.admin.login_enrollment_only", admin.id);
  return { ok: true, ...session, ...(enrolled ? {} : { mfaEnrollmentRequired: true }) };
}

// ───────────── 판매자 (대표·직원) ─────────────

export async function loginSeller(
  db: PrismaClient,
  input: { email: string; password: string; shopSlug?: string },
  meta: SessionMeta,
): Promise<LoginResult> {
  const now = meta.now ?? new Date();
  const audit = async (action: string, actorId: string | null, sellerId: string | null, reason?: string) =>
    writeAudit(db, { actorType: "SELLER_USER", actorId, sellerId, action, reason, ip: meta.ip, userAgent: meta.userAgent });
  if (await ipGate(db, "seller", meta, now, (a, r) => audit(a, null, null, r))) return fail("locked");

  const email = normalizeEmail(input.email);
  const candidates = await db.sellerUser.findMany({
    where: { email, ...(input.shopSlug ? { seller: { slug: input.shopSlug } } : {}) },
    include: { seller: true },
  });

  if (candidates.length === 0) {
    await burnPasswordCheck(input.password);
    const ipLocked = await recordIpFailure(db, "seller", meta.ip, now);
    await audit("auth.seller.login_failed", null, null, "unknown_account");
    return fail(ipLocked ? "locked" : "invalid_credentials");
  }

  // 같은 이메일로 여러 판매자 계정이 있으면(판매자별 별도 계정) 비밀번호가 맞는 계정을 찾는다.
  const unlocked = candidates.filter((u) => !isLocked(u, now));
  if (unlocked.length === 0) {
    for (const u of candidates) await audit("auth.seller.login_blocked", u.id, u.sellerId, "locked");
    return fail("locked");
  }
  const matched = [];
  for (const u of unlocked) if (await verifyPassword(u.passwordHash, input.password)) matched.push(u);

  if (matched.length === 0) {
    const ipLocked = await recordIpFailure(db, "seller", meta.ip, now);
    // 계정이 하나로 정해질 때만 계정 실패로 센다. 쇼핑몰이 특정되지 않은 실패(같은 이메일 여러 계정)는 IP로만 센다.
    if (candidates.length === 1) {
      const u = candidates[0];
      const accountLocked = await recordAccountFailure(db, "SellerUser", u.id, now);
      await audit(accountLocked ? "auth.seller.locked" : "auth.seller.login_failed", u.id, u.sellerId);
      return fail(accountLocked || ipLocked ? "locked" : "invalid_credentials");
    }
    await audit("auth.seller.login_failed", null, null, "shop_unspecified");
    return fail(ipLocked ? "locked" : "invalid_credentials");
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

  if (!(await recordAccountSuccess(db, "SellerUser", user.id, now))) return fail("locked");
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
  const audit = async (action: string, actorId: string | null, reason?: string) =>
    writeAudit(db, {
      actorType: "BUYER",
      actorId,
      sellerId: input.sellerId,
      action,
      reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  if (await ipGate(db, "buyer", meta, now, (a, r) => audit(a, null, r))) return fail("locked");

  const failed = async (memberId: string | null) => {
    const ipLocked = await recordIpFailure(db, "buyer", meta.ip, now);
    const accountLocked = memberId ? await recordAccountFailure(db, "BuyerMember", memberId, now) : false;
    await audit(accountLocked ? "auth.buyer.locked" : "auth.buyer.login_failed", memberId);
    return fail(accountLocked || ipLocked ? "locked" : "invalid_credentials");
  };

  const member = await db.buyerMember.findFirst({
    where: { sellerId: input.sellerId, loginId: input.loginId.trim(), deletedAt: null },
  });
  if (!member) {
    await burnPasswordCheck(input.password);
    return failed(null);
  }
  if (isLocked(member, now)) {
    await audit("auth.buyer.login_blocked", member.id, "locked");
    return fail("locked");
  }
  if (!(await verifyPassword(member.passwordHash, input.password))) return failed(member.id);
  if (member.status === "DORMANT") return fail("dormant");
  if (member.status !== "ACTIVE") return fail("account_disabled");

  if (!(await recordAccountSuccess(db, "BuyerMember", member.id, now))) return fail("locked");
  const session = await createBuyerSession(db, input.sellerId, member.id, { ...meta, now });
  await audit("auth.buyer.login", member.id);
  return { ok: true, ...session };
}
