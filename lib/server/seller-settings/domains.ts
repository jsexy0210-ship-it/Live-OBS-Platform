import { Prisma, type PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 쇼핑몰 도메인 연결(SA-060, PRODUCT_SCOPE 「쇼핑몰 주소」). 서버는 「등록 → DNS 안내 → 소유 확인(DNS 조회) → 해제」와 상태 표시까지만 한다.
// 실제 DNS 설정(플랫폼 쪽 연결 주소)·보안 인증서 발급·도메인에서 쇼핑몰로 연결하는 일은 하지 않는다(카카오클라우드 자원·대표님 승인 대상).
// - 등록: 소문자 호스트 이름만(IP·주소창 값·와일드카드·플랫폼 도메인 하위·포트 불가), 쇼핑몰마다 3개까지. 같은 이름은 전체에서 하나(다른 쇼핑몰이 쓰는 이름은 409 domain_taken, 누구 것인지 알려 주지 않음).
//   소유 확인을 못 한 채 7일이 지난 등록은 만료되어 같은 이름을 다시 등록할 수 있다(남이 먼저 선점해 두는 것을 막음).
// - 소유 확인: 도메인 DNS에 `_onq-verify.도메인` TXT `onq-verify=확인값`을 넣으면 확인된다. 확인 시도는 도메인마다 15초에 한 번.
// - 변경은 SHOP_SETTINGS(대표자·직원), 조회는 SHOP_SETTINGS 읽기. 쇼핑몰이 잠기면 가드가 막는다(도메인 신규 연결 금지, PRODUCT_SCOPE). 모든 변경은 로그 추적에 남긴다.
export const MAX_DOMAINS_PER_SELLER = 3;
export const PENDING_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
export const VERIFY_COOLDOWN_MS = 15_000;
export const VERIFY_TXT_NAME = "_onq-verify";
const DNS_TIMEOUT_MS = 5000;

// 플랫폼 쪽 연결 주소(도메인 회사 DNS에 CNAME으로 넣을 값). 환경변수로 정하고 없으면 기본값. A 레코드는 고정 IP가 정해진 뒤에만(환경변수).
export function dnsTargets() {
  return { cname: process.env.SHOP_DOMAIN_CNAME_TARGET || "shops.on-aircue.com", a: process.env.SHOP_DOMAIN_A_TARGET || null };
}
const PLATFORM_DOMAIN = "on-aircue.com";

export const DOMAIN_MESSAGES = {
  invalid_domain: "도메인은 shop.example.com 같은 영문 소문자 주소로 입력해 주십시오(주소창 전체나 IP, 포트는 쓸 수 없습니다)",
  reserved_domain: "ONQ 기본 주소 아래의 주소는 연결할 수 없습니다",
  domain_taken: "이미 다른 곳에서 연결 중인 도메인입니다",
  too_many_domains: `도메인은 ${MAX_DOMAINS_PER_SELLER}개까지 연결할 수 있습니다`,
  not_found: "도메인을 찾을 수 없습니다",
  verify_too_soon: "잠시 뒤에 다시 확인해 주십시오",
  already_verified: "이미 소유 확인이 끝난 도메인입니다",
} as const;
export type DomainReason = keyof typeof DOMAIN_MESSAGES;
export const DOMAIN_STATUS: Record<DomainReason, number> = { invalid_domain: 400, reserved_domain: 400, domain_taken: 409, too_many_domains: 409, not_found: 404, verify_too_soon: 429, already_verified: 409 };

// 소문자 호스트 이름: 점으로 나뉜 2개 이상 라벨(각 1~63자, 영문 소문자·숫자·하이픈, 앞뒤 하이픈 불가), 전체 253자 이하, 마지막 라벨은 글자 2자 이상. 앞뒤 공백·끝 점은 정리한다.
export function normalizeHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().replace(/\.$/, "");
  if (h.length === 0 || h.length > 253 || h !== h.toLowerCase() || isIP(h) !== 0) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  return /^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1]) ? h : null;
}

export type DomainStatus = "PENDING_VERIFICATION" | "VERIFIED" | "SUSPENDED";
type Row = { id: string; hostname: string; verifiedAt: Date | null; certStatus: string | null; suspendedAt: Date | null; verifyToken: string; lastCheckedAt: Date | null; createdAt: Date };

function view(r: Row) {
  const status: DomainStatus = r.suspendedAt ? "SUSPENDED" : r.verifiedAt ? "VERIFIED" : "PENDING_VERIFICATION";
  const t = dnsTargets();
  return {
    id: r.id,
    hostname: r.hostname,
    status,
    verifiedAt: r.verifiedAt,
    // 소유 확인 뒤 인증서 상태(발급은 플랫폼이 한다). 확인 전에는 null
    certStatus: r.verifiedAt ? (r.certStatus ?? "PENDING") : null,
    suspendedAt: r.suspendedAt,
    createdAt: r.createdAt,
    expiresAt: r.verifiedAt ? null : new Date(r.createdAt.getTime() + PENDING_EXPIRE_MS),
    dns: {
      verify: { type: "TXT", name: `${VERIFY_TXT_NAME}.${r.hostname}`, value: `onq-verify=${r.verifyToken}` },
      connect: { type: "CNAME", name: r.hostname, value: t.cname, a: t.a },
    },
  };
}
export type DomainView = ReturnType<typeof view>;

const SELECT = { id: true, hostname: true, verifiedAt: true, certStatus: true, suspendedAt: true, verifyToken: true, lastCheckedAt: true, createdAt: true } as const;

export async function listDomains(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const rows = await db.sellerDomain.findMany({ where: { sellerId: ctx.sellerId }, select: SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const now = Date.now();
  // 확인 못 한 채 만료된 등록은 목록에서 뺀다(실제 정리는 같은 이름을 다시 등록할 때)
  return { domains: rows.filter((r) => r.verifiedAt || now - r.createdAt.getTime() < PENDING_EXPIRE_MS).map(view), limit: MAX_DOMAINS_PER_SELLER, targets: dnsTargets() };
}

type Meta = { ip?: string | null; userAgent?: string | null };
const lockHost = (tx: Prisma.TransactionClient, hostname: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_domain:${hostname}`}))`;
const lockSeller = (tx: Prisma.TransactionClient, sellerId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_domains:${sellerId}`}))`;

// 본문: { hostname }. 등록하면 소유 확인 안내(dns)를 함께 준다.
export async function createDomain(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: Meta = {}, now = new Date()) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const hostname = b ? normalizeHostname(b.hostname) : null;
  if (!hostname || Object.keys(b!).some((k) => k !== "hostname")) return { ok: false as const, reason: "invalid_domain" as const };
  if (hostname === PLATFORM_DOMAIN || hostname.endsWith(`.${PLATFORM_DOMAIN}`)) return { ok: false as const, reason: "reserved_domain" as const };
  return db.$transaction(async (tx) => {
    await lockHost(tx, hostname);
    await lockSeller(tx, ctx.sellerId);
    // 소유 확인을 못 한 채 만료된 같은 이름의 등록은 지워 다시 등록할 수 있게 한다
    await tx.sellerDomain.deleteMany({ where: { hostname, verifiedAt: null, createdAt: { lt: new Date(now.getTime() - PENDING_EXPIRE_MS) } } });
    if (await tx.sellerDomain.findUnique({ where: { hostname }, select: { id: true } })) return { ok: false as const, reason: "domain_taken" as const };
    const mine = await tx.sellerDomain.count({ where: { sellerId: ctx.sellerId, OR: [{ verifiedAt: { not: null } }, { createdAt: { gte: new Date(now.getTime() - PENDING_EXPIRE_MS) } }] } });
    if (mine >= MAX_DOMAINS_PER_SELLER) return { ok: false as const, reason: "too_many_domains" as const };
    const row = await tx.sellerDomain.create({ data: { sellerId: ctx.sellerId, hostname, verifyToken: randomBytes(16).toString("hex"), createdAt: now }, select: SELECT });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.domain.create", targetType: "SellerDomain", targetId: row.id, after: { hostname }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, domain: view(row) };
  });
}

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// DNS TXT 조회(교체 가능: 시험에서 바꿔 끼운다). 레코드가 없으면 빈 목록, 시간 초과·오류도 빈 목록으로 본다(확인 실패일 뿐 서버 오류가 아니다).
export type TxtResolver = (name: string) => Promise<string[]>;
const defaultResolver: TxtResolver = async (name) => {
  try {
    const records = await Promise.race([resolveTxt(name), new Promise<string[][]>((_, rej) => setTimeout(() => rej(new Error("dns_timeout")), DNS_TIMEOUT_MS))]);
    return records.map((parts) => parts.join(""));
  } catch {
    return [];
  }
};
let resolver: TxtResolver = defaultResolver;
export function setTxtResolverForTest(r: TxtResolver | null) {
  resolver = r ?? defaultResolver;
}

// 소유 확인(DNS 조회). 맞으면 verifiedAt을 기록한다(certStatus는 PENDING). 맞지 않으면 바뀌는 것 없이 { verified: false }.
export async function verifyDomain(db: PrismaClient, ctx: TenantContext, id: string, meta: Meta = {}, now = new Date()) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  // 확인 시도 제한을 먼저 한 줄로 잡아 연속 호출이 DNS 조회를 여러 번 일으키지 못하게 한다(조건부 갱신)
  const claim = await db.sellerDomain.updateMany({
    where: { id, sellerId: ctx.sellerId, verifiedAt: null, suspendedAt: null, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - VERIFY_COOLDOWN_MS) } }] },
    data: { lastCheckedAt: now },
  });
  const row = await db.sellerDomain.findFirst({ where: { id, sellerId: ctx.sellerId }, select: SELECT });
  if (!row) return { ok: false as const, reason: "not_found" as const };
  if (row.verifiedAt) return { ok: false as const, reason: "already_verified" as const };
  if (claim.count === 0) return { ok: false as const, reason: row.suspendedAt ? ("not_found" as const) : ("verify_too_soon" as const) };
  const values = await resolver(`${VERIFY_TXT_NAME}.${row.hostname}`);
  const verified = values.some((v) => v.trim() === `onq-verify=${row.verifyToken}`);
  if (!verified) return { ok: true as const, verified: false as const, domain: view(row) };
  const updated = await db.$transaction(async (tx) => {
    const r = await tx.sellerDomain.updateMany({ where: { id, sellerId: ctx.sellerId, verifiedAt: null }, data: { verifiedAt: now, certStatus: "PENDING" } });
    if (r.count === 0) return null;
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.domain.verify", targetType: "SellerDomain", targetId: id, after: { hostname: row.hostname }, ip: meta.ip, userAgent: meta.userAgent });
    return tx.sellerDomain.findUniqueOrThrow({ where: { id }, select: SELECT });
  });
  return { ok: true as const, verified: true as const, domain: view(updated ?? { ...row, verifiedAt: now, certStatus: "PENDING" }) };
}

// 해제(연결 지우기). 없는 도메인은 404, 다른 쇼핑몰 것도 404.
export async function deleteDomain(db: PrismaClient, ctx: TenantContext, id: string, meta: Meta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const row = await tx.sellerDomain.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { id: true, hostname: true, verifiedAt: true } });
    if (!row) return { ok: false as const, reason: "not_found" as const };
    await lockHost(tx, row.hostname);
    const r = await tx.sellerDomain.deleteMany({ where: { id, sellerId: ctx.sellerId } });
    if (r.count === 0) return { ok: false as const, reason: "not_found" as const };
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.domain.delete", targetType: "SellerDomain", targetId: id, before: { hostname: row.hostname, verified: row.verifiedAt !== null }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const };
  });
}
