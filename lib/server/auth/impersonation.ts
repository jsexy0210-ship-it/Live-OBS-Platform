import type { ImpersonationCategory, ImpersonationRelatedKind, ImpersonationScope, Prisma, PrismaClient, Seller } from "@prisma/client";
import { policyValue } from "../admin/platformPolicy";
import { writeAudit } from "../audit/log";
import { forbidden, notFound } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { cleanText } from "../text/clean";
import type { AdminSessionContext } from "./session";
import { generateToken, hashToken } from "./token";

// 마스터 대리 조회(MA-016): 마스터 관리자가 사유를 적고 파트너스 화면을 읽기 전용으로 본다.
// - 권한은 seller.impersonate(최고관리자·운영·CS, 조회 전용 역할은 불가). 사유는 1~200자 필수.
// - 별도 세션(AdminImpersonationSession, 30분)이고 쿠키 lo_imp(경로 /api/seller)로만 온다. 토큰은 「imp.」로 시작해 파트너스 세션과 구분한다.
// - 열 때 admin.impersonate.view, 끝낼 때 admin.impersonate.end(after.cause: manual·replaced·expired)를 로그 추적에 남긴다. 만료는 처음 알아챈 때(쓰던 요청·내 세션 조회·다시 열기·끝내기)에 한 번 남긴다. 한 관리자에게 열린 세션은 하나만(새로 열면 앞의 것을 끝낸다).
// - 읽기 전용은 두 겹이다: ① proxy가 조회 허용 경로(IMPERSONATION_API_PREFIXES) 밖과 GET·HEAD 아닌 요청을 막는다(경로를 하나씩 믿지 않는 안전망).
//   ② 가드가 돌려주는 컨텍스트는 readOnly이고 대표자·직원 권한이 없어, 조회 권한 표(IMPERSONATION_READ_ACTIONS) 밖은 모두 거부된다.
// - 열린 동안 관리자 계정이 정지되거나 권한을 잃으면, 파트너스 쇼핑몰이 운영·정지 상태가 아니면 바로 막힌다.
export const IMPERSONATION_COOKIE = "lo_imp";
export const IMPERSONATION_PREFIX = "imp.";
export const IMPERSONATION_TTL_MS = 30 * 60_000;
export const REASON_MAX = 200;
// 접근 사유 분류·관련 건·열람 범위·세션 시간(MA-016). 분류가 문의 대응·장애 확인이면 같은 쇼핑몰의 관련 건이 필수다.
export const IMPERSONATION_CATEGORIES = ["INQUIRY", "INCIDENT", "FINANCE_CHECK", "AUDIT"] as const satisfies readonly ImpersonationCategory[];
export const IMPERSONATION_RELATED_KINDS = ["INQUIRY", "NOTIFICATION", "REPORT"] as const satisfies readonly ImpersonationRelatedKind[];
export const IMPERSONATION_SCOPES = ["BROADCAST", "OVERLAY", "ORDERS", "MEMBERS", "SETTINGS_PG"] as const satisfies readonly ImpersonationScope[];
export const IMPERSONATION_DURATIONS = [15, 30, 60] as const;
// 60분은 최고관리자만
export const IMPERSONATION_LONG_MINUTES = 60;
// 범위를 받지 않은 이전 방식 요청의 기본 범위(그때 열려 있던 화면). 화면이 새 입력을 보내면 쓰이지 않는다.
export const IMPERSONATION_LEGACY_SCOPES: readonly ImpersonationScope[] = ["ORDERS", "MEMBERS"];
// 대리 조회로 열리는 파트너스 API(조회 권한 표 IMPERSONATION_READ_ACTIONS와 맞춘다). 이 밖은 proxy가 403으로 막는다.
export const IMPERSONATION_API_PREFIXES = ["/api/seller/orders", "/api/seller/members", "/api/seller/products", "/api/seller/stats", "/api/seller/impersonation"] as const;
// 파트너스 화면 틀(SellerShell)이 처음에 읽는 내 정보. 하위 경로(/me/password 등)는 열지 않는 정확 일치만 허용한다.
// 외부 쇼핑몰 연동 조회(GET /api/seller/external-shops 목록만, 하위 경로 [id]·oauth-done은 열지 않는다)도 같은 정확 일치.
export const IMPERSONATION_API_EXACT = ["/api/seller/me", "/api/seller/external-shops"] as const;
// 로그인 전 흐름(로그인·로그아웃·비밀번호 재설정·아이디 찾기)은 세션 없이 자격 증명으로 동작하므로, 같은 브라우저에 대리 조회 쿠키가 남아 있어도 proxy가 막지 않는다.
// (로그인 성공·로그아웃 때 라우트가 대리 조회 쿠키를 지워 대리 조회가 파트너스 로그인을 가리지 않게 한다)
export const IMPERSONATION_PUBLIC_PREFIXES = ["/api/seller/auth/login", "/api/seller/auth/logout", "/api/seller/password-reset", "/api/seller/find-id"] as const;
export const isImpersonationPublicPath = (pathname: string) => IMPERSONATION_PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
// 대리 조회에서 화면 틀이 메뉴를 고르는 데만 쓰는 권한 표시(IMPERSONATION_READ_ACTIONS 중 화면 권한). 서버 권한은 이 값과 무관하게 readOnly 컨텍스트가 정한다.
export const IMPERSONATION_VIEW_PERMISSIONS = ["ORDER_SHIPPING", "PRODUCT_MANAGE", "MEMBER_POINTS", "SALES_VIEW"] as const;

export const isImpersonationToken = (t: string | undefined): t is string => !!t && t.startsWith(IMPERSONATION_PREFIX);

// proxy가 쓴다: 대리 조회 쿠키가 있는 요청이 이 경로·방식이면 통과
export function impersonationRequestAllowed(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return (IMPERSONATION_API_EXACT as readonly string[]).includes(pathname) || IMPERSONATION_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

type Meta = { ip?: string | null; userAgent?: string | null };
export type ImpersonationRejection =
  | "reason_required"
  | "seller_not_viewable"
  | "category_invalid"
  | "related_required"
  | "related_invalid"
  | "scopes_required"
  | "duration_invalid"
  | "duration_not_allowed";
export type ImpersonationInput = { category?: unknown; relatedKind?: unknown; relatedId?: unknown; scopes?: unknown; durationMinutes?: unknown };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

// 관련 건이 이 쇼핑몰 것인지(다른 쇼핑몰 건은 존재 여부도 알리지 않고 related_invalid)
async function relatedBelongs(db: PrismaClient, kind: ImpersonationRelatedKind, id: string, sellerId: string): Promise<boolean> {
  if (kind === "INQUIRY") return !!(await db.platformInquiry.findFirst({ where: { id, sellerId }, select: { id: true } }));
  if (kind === "NOTIFICATION") return !!(await db.adminAlert.findFirst({ where: { id, sellerId }, select: { id: true } }));
  return !!(await db.productReviewReport.findFirst({ where: { id, sellerId }, select: { id: true } }));
}

type EndCause = "manual" | "replaced" | "expired";
type Db = PrismaClient | Prisma.TransactionClient;
// 열린 세션을 끝내고 로그 추적(admin.impersonate.end, after.cause)을 한 번만 남긴다. 같은 세션을 동시에 끝내도 먼저 끝낸 쪽만 기록한다.
async function closeSessions(db: Db, where: Prisma.AdminImpersonationSessionWhereInput, cause: EndCause, now: Date, meta: Meta = {}) {
  const open = await db.adminImpersonationSession.findMany({ where: { ...where, endedAt: null }, select: { id: true, adminId: true, sellerId: true, expiresAt: true } });
  let ended = 0;
  for (const s of open) {
    const r = await db.adminImpersonationSession.updateMany({ where: { id: s.id, endedAt: null }, data: { endedAt: cause === "expired" ? s.expiresAt : now } });
    if (r.count !== 1) continue;
    ended++;
    await writeAudit(db, {
      actorType: "PLATFORM_ADMIN",
      actorId: s.adminId,
      sellerId: s.sellerId,
      action: "admin.impersonate.end",
      targetType: "Seller",
      targetId: s.sellerId,
      after: { cause },
      ip: cause === "manual" ? meta.ip : null,
      userAgent: cause === "manual" ? meta.userAgent : null,
    });
  }
  return ended;
}

export async function startImpersonation(db: PrismaClient, admin: AdminSessionContext, sellerId: string, rawReason: unknown, meta: Meta = {}, now = new Date(), input: ImpersonationInput = {}) {
  if (!adminCan(admin.admin.role, "seller.impersonate")) throw forbidden();
  const reason = cleanText(rawReason, REASON_MAX, "memo");
  if (!reason) return { ok: false as const, reason: "reason_required" as const };
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { id: true, shopName: true, slug: true, status: true } });
  if (!seller) throw notFound();
  if (seller.status !== "ACTIVE" && seller.status !== "SUSPENDED") return { ok: false as const, reason: "seller_not_viewable" as const };
  // 분류·관련 건·범위·시간(MA-016). 아무것도 보내지 않은 이전 방식 요청은 이전 범위·기본 시간으로 연다(화면이 새 입력을 보내면 모두 검사한다).
  let category: ImpersonationCategory | null = null;
  let relatedKind: ImpersonationRelatedKind | null = null;
  let relatedId: string | null = null;
  if (input.category !== undefined) {
    if (!oneOf(IMPERSONATION_CATEGORIES, input.category)) return { ok: false as const, reason: "category_invalid" as const };
    category = input.category;
    const needsRelated = category === "INQUIRY" || category === "INCIDENT";
    if (input.relatedKind !== undefined || input.relatedId !== undefined) {
      if (!oneOf(IMPERSONATION_RELATED_KINDS, input.relatedKind) || typeof input.relatedId !== "string" || !UUID.test(input.relatedId)) return { ok: false as const, reason: "related_invalid" as const };
      if (!(await relatedBelongs(db, input.relatedKind, input.relatedId, sellerId))) return { ok: false as const, reason: "related_invalid" as const };
      relatedKind = input.relatedKind;
      relatedId = input.relatedId;
    } else if (needsRelated) {
      return { ok: false as const, reason: "related_required" as const };
    }
  }
  let scopes: ImpersonationScope[] = [...IMPERSONATION_LEGACY_SCOPES];
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes) || input.scopes.length === 0 || !input.scopes.every((x) => oneOf(IMPERSONATION_SCOPES, x))) return { ok: false as const, reason: "scopes_required" as const };
    scopes = [...new Set(input.scopes as ImpersonationScope[])];
  }
  // 대신 보기 기본 세션 길이는 플랫폼 기본 정책(MA-081, 기본 30분, 최대 60분)이다. 화면이 15·30·60분을 고르면 그 값(60분은 최고관리자만).
  let minutes = await policyValue(db, "impersonationMinutes");
  if (input.durationMinutes !== undefined) {
    if (typeof input.durationMinutes !== "number" || !(IMPERSONATION_DURATIONS as readonly number[]).includes(input.durationMinutes)) return { ok: false as const, reason: "duration_invalid" as const };
    if (input.durationMinutes === IMPERSONATION_LONG_MINUTES && admin.admin.role !== "SUPER_ADMIN") return { ok: false as const, reason: "duration_not_allowed" as const };
    minutes = input.durationMinutes;
  }
  const token = IMPERSONATION_PREFIX + generateToken();
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  await db.$transaction(async (tx) => {
    await closeSessions(tx, { adminId: admin.admin.id, expiresAt: { lte: now } }, "expired", now);
    await closeSessions(tx, { adminId: admin.admin.id }, "replaced", now);
    await tx.adminImpersonationSession.create({
      data: { adminId: admin.admin.id, sellerId, tokenHash: hashToken(token), reason, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, expiresAt, createdAt: now, category, relatedKind, relatedId, scopes },
    });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: "admin.impersonate.view",
      targetType: "Seller",
      targetId: sellerId,
      reason,
      after: { category, relatedKind, relatedId, scopes, minutes },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, token, expiresAt, scopes, seller: { id: seller.id, shopName: seller.shopName, slug: seller.slug } };
}

// 이 관리자에게 열린 대리 조회를 모두 끝낸다(쿠키가 /api/seller로만 가서 관리자 쪽은 쿠키 없이 관리자 신원으로 끝낸다)
export async function endImpersonation(db: PrismaClient, admin: AdminSessionContext, meta: Meta = {}, now = new Date()) {
  const ended = await db.$transaction(async (tx) => {
    await closeSessions(tx, { adminId: admin.admin.id, expiresAt: { lte: now } }, "expired", now);
    return closeSessions(tx, { adminId: admin.admin.id }, "manual", now, meta);
  });
  return { ended };
}

export async function activeImpersonation(db: PrismaClient, admin: AdminSessionContext, now = new Date()) {
  await closeSessions(db, { adminId: admin.admin.id, expiresAt: { lte: now } }, "expired", now);
  const s = await db.adminImpersonationSession.findFirst({
    where: { adminId: admin.admin.id, endedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (!s) return null;
  const seller = await db.seller.findUnique({ where: { id: s.sellerId }, select: { id: true, shopName: true, slug: true } });
  return {
    sellerId: s.sellerId,
    shopName: seller?.shopName ?? null,
    slug: seller?.slug ?? null,
    reason: s.reason,
    category: s.category,
    relatedKind: s.relatedKind,
    relatedId: s.relatedId,
    scopes: s.scopes,
    startedAt: s.createdAt,
    expiresAt: s.expiresAt,
  };
}

export type ImpersonationContext = { sessionId: string; adminId: string; adminName: string; seller: Seller; reason: string; scopes: readonly ImpersonationScope[]; startedAt: Date; expiresAt: Date };

// 파트너스 가드가 쓴다. 끝났거나 만료됐거나, 관리자가 정지·권한 상실이거나, 쇼핑몰이 운영·정지가 아니면 null(401).
export async function resolveImpersonation(db: PrismaClient, token: string | undefined, now = new Date()): Promise<ImpersonationContext | null> {
  if (!isImpersonationToken(token)) return null;
  const s = await db.adminImpersonationSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!s || s.endedAt) return null;
  if (s.expiresAt <= now) {
    await closeSessions(db, { id: s.id }, "expired", now);
    return null;
  }
  const [admin, seller] = await Promise.all([db.platformAdmin.findUnique({ where: { id: s.adminId } }), db.seller.findUnique({ where: { id: s.sellerId } })]);
  if (!admin || admin.status !== "ACTIVE" || !adminCan(admin.role, "seller.impersonate")) return null;
  if (!seller || (seller.status !== "ACTIVE" && seller.status !== "SUSPENDED")) return null;
  return { sessionId: s.id, adminId: admin.id, adminName: admin.name, seller, reason: s.reason, scopes: s.scopes, startedAt: s.createdAt, expiresAt: s.expiresAt };
}
