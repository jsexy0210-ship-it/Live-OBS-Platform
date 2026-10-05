import type { Prisma, PrismaClient, ShopLegalDoc, ShopLegalKind } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰별 이용약관·개인정보처리방침(파트너스 입력 SA · 구매자 /shop/[슬러그]/terms·privacy). 규칙:
// - 본문은 파트너스가 입력한 글자 그대로 보여 준다(화면은 텍스트로만 그림, HTML 해석 없음). 기본 서식(docs/terms)은 게시 조건이 있어 앱이 대신 게시하지 않는다.
// - 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만. 쇼핑몰·종류마다 한 줄이고 저장할 때마다 version이 올라간다(다른 창 덮어쓰기 막기).
// - 게시하려면 본문과 시행일이 있어야 한다. 게시하지 않았으면 구매자 화면은 「준비 중」 안내. 처음 게시한 시각(publishedAt)은 내용을 고쳐도 유지한다.
// - 로그 추적에는 본문을 남기지 않고 글자 수만 남긴다. 구매자 조회는 로그인 없이, 운영 중인 쇼핑몰(shopOpen)만.

type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const BODY_MAX = 60_000;
export type ShopLegalRejection = "invalid_body" | "invalid_date" | "publish_incomplete" | "version_conflict";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const SHOP_LEGAL_MESSAGES: Record<ShopLegalRejection, string> = {
  invalid_body: `본문을 ${BODY_MAX.toLocaleString("ko-KR")}자 안에서 입력해 주십시오`,
  invalid_date: "시행일을 날짜(연-월-일)로 입력해 주십시오",
  publish_incomplete: "게시하려면 본문과 시행일을 입력해 주십시오",
  version_conflict: "다른 곳에서 먼저 고쳤습니다. 새로고침한 뒤 다시 시도해 주십시오",
};

export type LegalKindParam = "terms" | "privacy";
export function parseKind(v: unknown): ShopLegalKind | null {
  return v === "terms" ? "TERMS" : v === "privacy" ? "PRIVACY" : null;
}
const param = (k: ShopLegalKind): LegalKindParam => (k === "TERMS" ? "terms" : "privacy");

const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const lockSeller = (tx: Tx, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 시행일: 실제 있는 날짜만(2000~2100년). 없으면 null, 형식이 틀리면 undefined.
function parseDate(v: unknown): Date | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return undefined;
  const m = DATE.exec(v);
  if (!m) return undefined;
  const d = new Date(`${v}T00:00:00.000Z`);
  const ok = !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && +m[1] >= 2000 && +m[1] <= 2100;
  return ok ? d : undefined;
}
const dateText = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const view = (kind: ShopLegalKind, r: ShopLegalDoc | null) => ({
  kind: param(kind),
  body: r?.body ?? "",
  effectiveOn: dateText(r?.effectiveOn ?? null),
  isPublished: r?.isPublished ?? false,
  version: r?.version ?? 0,
  updatedAt: r?.updatedAt ?? null,
});
const auditView = (r: ShopLegalDoc | null) => ({ isPublished: r?.isPublished ?? false, effectiveOn: dateText(r?.effectiveOn ?? null), version: r?.version ?? 0, bodyLength: [...(r?.body ?? "")].length });

// ───────── 파트너스 관리자 ─────────

export async function readSellerLegal(db: PrismaClient, ctx: TenantContext, kind: ShopLegalKind) {
  return view(kind, await db.shopLegalDoc.findUnique({ where: { sellerId_kind: { sellerId: ctx.sellerId, kind } } }));
}

// 저장(처음이면 만든다). 본문: { body, effectiveOn(YYYY-MM-DD)?, isPublished?, expectedVersion }
export async function saveSellerLegal(db: PrismaClient, ctx: TenantContext, kind: ShopLegalKind, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const b = obj(raw);
  const body = b.body === undefined || b.body === null || b.body === "" ? "" : cleanText(b.body, BODY_MAX, "multiline");
  if (body === null) return { ok: false as const, reason: "invalid_body" as const };
  const effectiveOn = parseDate(b.effectiveOn);
  if (effectiveOn === undefined) return { ok: false as const, reason: "invalid_date" as const };
  const isPublished = b.isPublished === true;
  if (isPublished && (!body || !effectiveOn)) return { ok: false as const, reason: "publish_incomplete" as const };
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopLegalDoc.findUnique({ where: { sellerId_kind: { sellerId: ctx.sellerId, kind } } });
    const current = before?.version ?? 0;
    if (b.expectedVersion !== current) return { ok: false as const, reason: "version_conflict" as const, currentVersion: current };
    const publishedAt = isPublished ? (before?.isPublished && before.publishedAt ? before.publishedAt : new Date()) : null;
    const data = { body, effectiveOn, isPublished, publishedAt, version: current + 1 };
    const row = before
      ? await tx.shopLegalDoc.update({ where: { id: before.id }, data })
      : await tx.shopLegalDoc.create({ data: { sellerId: ctx.sellerId, kind, ...data } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.legal.update",
      targetType: "ShopLegalDoc",
      targetId: row.id,
      before: { kind, ...auditView(before) },
      after: { kind, ...auditView(row) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, doc: view(kind, row) };
  });
}

// ───────── 구매자 ─────────

// 게시본 읽기(쇼핑몰이 운영 중인지는 부르는 쪽이 shopOpen으로 먼저 확인한다). 게시하지 않았으면 { published: false }(화면은 「준비 중」).
export async function publicLegalOf(db: PrismaClient, sellerId: string, kind: ShopLegalKind) {
  const row = await db.shopLegalDoc.findUnique({ where: { sellerId_kind: { sellerId, kind } } });
  if (!row || !row.isPublished) return { published: false as const, kind: param(kind) };
  return { published: true as const, kind: param(kind), body: row.body, effectiveOn: dateText(row.effectiveOn), version: row.version };
}

// 쇼핑몰 주소로 읽기. 없거나 운영 중이 아닌 쇼핑몰이면 null(404).
export async function publicLegal(db: PrismaClient, slug: string, kind: ShopLegalKind) {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  return publicLegalOf(db, shop.id, kind);
}
