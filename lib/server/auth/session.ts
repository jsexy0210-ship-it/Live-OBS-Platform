import type { PlatformAdmin, PrismaClient, Seller, SellerUser, BuyerMember } from "@prisma/client";
import { generateToken, hashToken } from "./token";
import { isSessionActive, sessionExpiry, type BroadcastActivity, type Realm } from "./policy";

export type SessionMeta = { ip?: string | null; userAgent?: string | null; now?: Date };
export type IssuedSession = { token: string; expiresAt: Date };

// 마지막 활동 시각은 1분에 한 번만 갱신해 요청마다 쓰기가 생기지 않게 한다.
const TOUCH_INTERVAL_MS = 60_000;

export async function createAdminSession(
  db: PrismaClient,
  adminId: string,
  opts: { mfaVerified: boolean; enrollmentOnly: boolean },
  meta: SessionMeta,
): Promise<IssuedSession> {
  const now = meta.now ?? new Date();
  const token = generateToken();
  const expiresAt = sessionExpiry("admin", now);
  await db.adminSession.create({
    data: {
      adminId,
      tokenHash: hashToken(token),
      mfaVerifiedAt: opts.mfaVerified ? now : null,
      enrollmentOnly: opts.enrollmentOnly,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
    },
  });
  return { token, expiresAt };
}

export async function createSellerSession(
  db: PrismaClient,
  sellerId: string,
  sellerUserId: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const now = meta.now ?? new Date();
  const token = generateToken();
  const expiresAt = sessionExpiry("seller", now);
  await db.sellerSession.create({
    data: {
      sellerId,
      sellerUserId,
      tokenHash: hashToken(token),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
    },
  });
  return { token, expiresAt };
}

export async function createBuyerSession(
  db: PrismaClient,
  sellerId: string,
  buyerMemberId: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const now = meta.now ?? new Date();
  const token = generateToken();
  const expiresAt = sessionExpiry("buyer", now);
  await db.buyerSession.create({
    data: { sellerId, buyerMemberId, tokenHash: hashToken(token), expiresAt, lastSeenAt: now, createdAt: now },
  });
  return { token, expiresAt };
}

// enrollmentOnly: TOTP 등록 전용 제한 세션. requireAdmin은 거부하고 등록 API만 받는다.
export type AdminSessionContext = { admin: PlatformAdmin; sessionId: string; enrollmentOnly: boolean };

export async function resolveAdminSession(
  db: PrismaClient,
  token: string | undefined,
  now = new Date(),
): Promise<AdminSessionContext | null> {
  if (!token) return null;
  const s = await db.adminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { admin: true } });
  if (!s || !isSessionActive("admin", s, now)) return null;
  if (s.admin.status !== "ACTIVE") return null;
  // 2단계 인증을 등록한 계정은 인증을 마친 세션만 인정한다(등록 전에 받은 제한 세션 포함 거부).
  if (s.admin.totpEnabledAt && !s.mfaVerifiedAt) return null;
  if (!s.admin.totpEnabledAt && !s.enrollmentOnly) return null;
  await touch(db, "admin", s.id, s.lastSeenAt, now);
  return { admin: s.admin, sessionId: s.id, enrollmentOnly: s.enrollmentOnly };
}

export type SellerSessionContext = { user: SellerUser; seller: Seller; sessionId: string };

export async function sellerBroadcastActivity(db: PrismaClient, sellerId: string): Promise<BroadcastActivity> {
  const [live, lastEnded] = await Promise.all([
    db.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true } }),
    db.broadcastSession.findFirst({
      where: { sellerId, status: "ENDED" },
      orderBy: { endedAt: "desc" },
      select: { endedAt: true },
    }),
  ]);
  return { live: !!live, lastEndedAt: lastEnded?.endedAt ?? null };
}

export async function resolveSellerSession(
  db: PrismaClient,
  token: string | undefined,
  now = new Date(),
): Promise<SellerSessionContext | null> {
  if (!token) return null;
  const s = await db.sellerSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { sellerUser: true, seller: true },
  });
  if (!s) return null;
  const broadcast = await sellerBroadcastActivity(db, s.sellerId);
  if (!isSessionActive("seller", s, now, broadcast)) return null;
  if (s.sellerUser.status !== "ACTIVE" || s.seller.status !== "ACTIVE") return null;
  await touch(db, "seller", s.id, s.lastSeenAt, now);
  return { user: s.sellerUser, seller: s.seller, sessionId: s.id };
}

export type BuyerSessionContext = { member: BuyerMember; sessionId: string };

// 구매자 세션은 쇼핑몰(판매자) 단위다. 다른 쇼핑몰에서 만든 세션은 받지 않는다.
export async function resolveBuyerSession(
  db: PrismaClient,
  token: string | undefined,
  sellerId: string,
  now = new Date(),
): Promise<BuyerSessionContext | null> {
  if (!token) return null;
  const s = await db.buyerSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { buyerMember: true } });
  if (!s || s.sellerId !== sellerId || !isSessionActive("buyer", s, now)) return null;
  if (s.buyerMember.deletedAt || s.buyerMember.status !== "ACTIVE") return null;
  await touch(db, "buyer", s.id, s.lastSeenAt, now);
  return { member: s.buyerMember, sessionId: s.id };
}

export async function revokeSession(db: PrismaClient, realm: Realm, token: string | undefined, now = new Date()) {
  if (!token) return;
  const where = { tokenHash: hashToken(token), revokedAt: null };
  const data = { revokedAt: now };
  if (realm === "admin") await db.adminSession.updateMany({ where, data });
  else if (realm === "seller") await db.sellerSession.updateMany({ where, data });
  else await db.buyerSession.updateMany({ where, data });
}

async function touch(db: PrismaClient, realm: Realm, id: string, lastSeenAt: Date, now: Date) {
  if (now.getTime() - lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  const args = { where: { id }, data: { lastSeenAt: now } };
  if (realm === "admin") await db.adminSession.update(args);
  else if (realm === "seller") await db.sellerSession.update(args);
  else await db.buyerSession.update(args);
}
