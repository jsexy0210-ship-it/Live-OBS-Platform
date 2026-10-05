import type { PrismaClient, Seller } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden, notFound } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { cleanText } from "../text/clean";
import type { AdminSessionContext } from "./session";
import { generateToken, hashToken } from "./token";

// 마스터 대리 조회(MA-016): 마스터 관리자가 사유를 적고 파트너스 화면을 읽기 전용으로 본다.
// - 권한은 seller.impersonate(최고관리자·운영·CS, 조회 전용 역할은 불가). 사유는 1~200자 필수.
// - 별도 세션(AdminImpersonationSession, 30분)이고 쿠키 lo_imp(경로 /api/seller)로만 온다. 토큰은 「imp.」로 시작해 파트너스 세션과 구분한다.
// - 열 때 admin.impersonate.view, 끝낼 때 admin.impersonate.end를 로그 추적에 남긴다. 한 관리자에게 열린 세션은 하나만(새로 열면 앞의 것을 끝낸다).
// - 읽기 전용은 두 겹이다: ① proxy가 조회 허용 경로(IMPERSONATION_API_PREFIXES) 밖과 GET·HEAD 아닌 요청을 막는다(경로를 하나씩 믿지 않는 안전망).
//   ② 가드가 돌려주는 컨텍스트는 readOnly이고 대표자·직원 권한이 없어, 조회 권한 표(IMPERSONATION_READ_ACTIONS) 밖은 모두 거부된다.
// - 열린 동안 관리자 계정이 정지되거나 권한을 잃으면, 파트너스 쇼핑몰이 운영·정지 상태가 아니면 바로 막힌다.
export const IMPERSONATION_COOKIE = "lo_imp";
export const IMPERSONATION_PREFIX = "imp.";
export const IMPERSONATION_TTL_MS = 30 * 60_000;
export const REASON_MAX = 200;
// 대리 조회로 열리는 파트너스 API(조회 권한 표 IMPERSONATION_READ_ACTIONS와 맞춘다). 이 밖은 proxy가 403으로 막는다.
export const IMPERSONATION_API_PREFIXES = ["/api/seller/orders", "/api/seller/members", "/api/seller/products", "/api/seller/stats", "/api/seller/impersonation"] as const;

export const isImpersonationToken = (t: string | undefined): t is string => !!t && t.startsWith(IMPERSONATION_PREFIX);

// proxy가 쓴다: 대리 조회 쿠키가 있는 요청이 이 경로·방식이면 통과
export function impersonationRequestAllowed(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return IMPERSONATION_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

type Meta = { ip?: string | null; userAgent?: string | null };
export type ImpersonationRejection = "reason_required" | "seller_not_viewable";

export async function startImpersonation(db: PrismaClient, admin: AdminSessionContext, sellerId: string, rawReason: unknown, meta: Meta = {}, now = new Date()) {
  if (!adminCan(admin.admin.role, "seller.impersonate")) throw forbidden();
  const reason = cleanText(rawReason, REASON_MAX, "memo");
  if (!reason) return { ok: false as const, reason: "reason_required" as const };
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { id: true, shopName: true, slug: true, status: true } });
  if (!seller) throw notFound();
  if (seller.status !== "ACTIVE" && seller.status !== "SUSPENDED") return { ok: false as const, reason: "seller_not_viewable" as const };
  const token = IMPERSONATION_PREFIX + generateToken();
  const expiresAt = new Date(now.getTime() + IMPERSONATION_TTL_MS);
  await db.$transaction(async (tx) => {
    await tx.adminImpersonationSession.updateMany({ where: { adminId: admin.admin.id, endedAt: null }, data: { endedAt: now } });
    await tx.adminImpersonationSession.create({
      data: { adminId: admin.admin.id, sellerId, tokenHash: hashToken(token), reason, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, expiresAt, createdAt: now },
    });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.impersonate.view", targetType: "Seller", targetId: sellerId, reason, ip: meta.ip, userAgent: meta.userAgent });
  });
  return { ok: true as const, token, expiresAt, seller: { id: seller.id, shopName: seller.shopName, slug: seller.slug } };
}

// 이 관리자에게 열린 대리 조회를 모두 끝낸다(쿠키가 /api/seller로만 가서 관리자 쪽은 쿠키 없이 관리자 신원으로 끝낸다)
export async function endImpersonation(db: PrismaClient, admin: AdminSessionContext, meta: Meta = {}, now = new Date()) {
  const open = await db.adminImpersonationSession.findMany({ where: { adminId: admin.admin.id, endedAt: null, expiresAt: { gt: now } }, select: { id: true, sellerId: true } });
  await db.$transaction(async (tx) => {
    await tx.adminImpersonationSession.updateMany({ where: { adminId: admin.admin.id, endedAt: null }, data: { endedAt: now } });
    for (const s of open) {
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId: s.sellerId, action: "admin.impersonate.end", targetType: "Seller", targetId: s.sellerId, ip: meta.ip, userAgent: meta.userAgent });
    }
  });
  return { ended: open.length };
}

export async function activeImpersonation(db: PrismaClient, admin: AdminSessionContext, now = new Date()) {
  const s = await db.adminImpersonationSession.findFirst({
    where: { adminId: admin.admin.id, endedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!s) return null;
  const seller = await db.seller.findUnique({ where: { id: s.sellerId }, select: { id: true, shopName: true, slug: true } });
  return { sellerId: s.sellerId, shopName: seller?.shopName ?? null, slug: seller?.slug ?? null, reason: s.reason, startedAt: s.createdAt, expiresAt: s.expiresAt };
}

export type ImpersonationContext = { sessionId: string; adminId: string; adminName: string; seller: Seller; reason: string; startedAt: Date; expiresAt: Date };

// 파트너스 가드가 쓴다. 끝났거나 만료됐거나, 관리자가 정지·권한 상실이거나, 쇼핑몰이 운영·정지가 아니면 null(401).
export async function resolveImpersonation(db: PrismaClient, token: string | undefined, now = new Date()): Promise<ImpersonationContext | null> {
  if (!isImpersonationToken(token)) return null;
  const s = await db.adminImpersonationSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!s || s.endedAt || s.expiresAt <= now) return null;
  const [admin, seller] = await Promise.all([db.platformAdmin.findUnique({ where: { id: s.adminId } }), db.seller.findUnique({ where: { id: s.sellerId } })]);
  if (!admin || admin.status !== "ACTIVE" || !adminCan(admin.role, "seller.impersonate")) return null;
  if (!seller || (seller.status !== "ACTIVE" && seller.status !== "SUSPENDED")) return null;
  return { sessionId: s.id, adminId: admin.id, adminName: admin.name, seller, reason: s.reason, startedAt: s.createdAt, expiresAt: s.expiresAt };
}
