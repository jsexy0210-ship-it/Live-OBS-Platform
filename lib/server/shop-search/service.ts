import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { sellerCan } from "../authz/permissions";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 검색 보조(자체 구현, 외부 서비스·유료 없음).
// - 검색어 확장: 판매자가 정한 유사어 묶음(예: 포켓몬·pokemon)에 검색어가 있으면 묶음의 모든 단어로 찾는다.
// - 상품 태그(Product.searchTags): 상품 이름 밖 키워드. 이름과 같이 검색·자동완성에 쓴다.
// - 인기 검색어: 검색 결과가 1개 이상 나온 검색어를 KST 날짜·단어별로 센다(개인 식별 정보 없음). 결과가 없는 말은 세지 않아 임의 단어를 밀어 넣을 수 없다.
export const TAG_MAX_COUNT = 10;
export const TAG_MAX_LENGTH = 20;
export const SYNONYM_GROUP_MAX = 50;
export const SYNONYM_WORDS_MIN = 2;
export const SYNONYM_WORDS_MAX = 10;
export const TERM_MIN_LENGTH = 2;
export const TERM_MAX_LENGTH = 20;
export const POPULAR_DAYS = 7;
export const POPULAR_LIMIT = 10;
export const SUGGEST_LIMIT = 8;
const KEEP_DAYS = 8;

const fold = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// 상품 태그 입력: 문자열 배열(최대 10개, 각 20자), 대소문자 무시 중복 제거. 비우려면 [] 또는 null. 틀리면 null.
export function parseSearchTags(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > TAG_MAX_COUNT * 3) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = cleanText(r, TAG_MAX_LENGTH, "name");
    if (!t) return null;
    const k = fold(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out.length <= TAG_MAX_COUNT ? out : null;
}

// 검색어 → 찾을 단어들(원래 검색어 + 같은 유사어 묶음의 단어)
export async function expandSearchTerm(db: PrismaClient, sellerId: string, term: string): Promise<string[]> {
  const groups = await db.shopSearchSynonym.findMany({ where: { sellerId }, select: { words: true } });
  const key = fold(term);
  const words = [term];
  for (const g of groups) if (g.words.some((w) => fold(w) === key)) words.push(...g.words);
  const seen = new Set<string>();
  return words.filter((w) => !seen.has(fold(w)) && !!seen.add(fold(w)));
}

// 상품 이름 또는 태그에 단어(부분 일치, 대소문자 무시)가 들어 있는 이 판매자의 상품 id.
// % _ 는 글자 그대로 찾는다(Prisma contains는 LIKE 기호를 막지 않아 이름 검색도 여기서 한다).
export async function productIdsByTerm(db: PrismaClient, sellerId: string, words: string[]): Promise<string[]> {
  if (!words.length) return [];
  const patterns = words.map((w) => `%${escapeLike(w)}%`);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT p."id" FROM "Product" p
    WHERE p."sellerId" = ${sellerId}::uuid AND p."deletedAt" IS NULL
      AND (p."name" ILIKE ANY(${patterns}::text[]) OR EXISTS (SELECT 1 FROM unnest(p."searchTags") t WHERE t ILIKE ANY(${patterns}::text[])))`;
  return rows.map((r) => r.id);
}

// 인기 검색어 집계(결과가 있었던 검색만 부른다). 기록 실패는 검색을 막지 않는다. 오래된 행은 같이 지운다.
export async function recordSearchTerm(db: PrismaClient, sellerId: string, term: string): Promise<void> {
  const t = fold(term);
  const len = [...t].length;
  if (len < TERM_MIN_LENGTH || len > TERM_MAX_LENGTH) return;
  try {
    await db.$executeRaw`
      INSERT INTO "ShopSearchTerm" ("sellerId", "day", "term", "count")
      VALUES (${sellerId}::uuid, (now() AT TIME ZONE 'Asia/Seoul')::date, ${t}, 1)
      ON CONFLICT ("sellerId", "day", "term") DO UPDATE SET "count" = "ShopSearchTerm"."count" + 1`;
    await db.$executeRaw`DELETE FROM "ShopSearchTerm" WHERE "sellerId" = ${sellerId}::uuid AND "day" < (now() AT TIME ZONE 'Asia/Seoul')::date - ${KEEP_DAYS}::int`;
  } catch {
    // 집계는 부가 기능이라 실패해도 검색 결과는 그대로 준다
  }
}

async function popularRows(db: PrismaClient, sellerId: string, prefix: string | null, limit: number) {
  const like = prefix ? `${escapeLike(fold(prefix))}%` : "%";
  return db.$queryRaw<{ term: string; total: bigint }[]>`
    SELECT "term", SUM("count")::bigint AS "total" FROM "ShopSearchTerm"
    WHERE "sellerId" = ${sellerId}::uuid AND "day" >= (now() AT TIME ZONE 'Asia/Seoul')::date - ${POPULAR_DAYS - 1}::int AND "term" LIKE ${like}
    GROUP BY "term" ORDER BY "total" DESC, "term" LIMIT ${limit}`;
}

// 인기 검색어: 최근 7일(KST, 오늘 포함) 상위 10개. 운영 중이 아닌 쇼핑몰은 null(404).
export async function popularSearchTerms(db: PrismaClient, slug: string) {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  return { terms: (await popularRows(db, shop.id, null, POPULAR_LIMIT)).map((r) => r.term) };
}

export type Suggestion = { text: string; kind: "term" | "product" | "tag" };

// 자동완성: 인기 검색어(앞부분 일치) → 상품 이름(유사어 포함) → 태그 순서로 최대 8개, 같은 글자는 한 번만. 검색어는 1~20자(그 밖은 빈 목록).
export async function searchSuggestions(db: PrismaClient, slug: string, rawQ: unknown) {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const q = cleanText(rawQ, TERM_MAX_LENGTH, "name");
  if (!q) return { suggestions: [] as Suggestion[] };
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (text: string, kind: Suggestion["kind"]) => {
    const k = fold(text);
    if (out.length < SUGGEST_LIMIT && !seen.has(k)) {
      seen.add(k);
      out.push({ text, kind });
    }
  };
  for (const r of await popularRows(db, shop.id, q, 3)) push(r.term, "term");
  const words = await expandSearchTerm(db, shop.id, q);
  const patterns = words.map((w) => `%${escapeLike(w)}%`);
  const names = await db.$queryRaw<{ name: string }[]>`
    SELECT p."name" FROM "Product" p
    WHERE p."sellerId" = ${shop.id}::uuid AND p."deletedAt" IS NULL AND p."status" IN ('ON_SALE', 'SOLD_OUT') AND p."name" ILIKE ANY(${patterns}::text[])
    ORDER BY p."createdAt" DESC, p."id" LIMIT 20`;
  const key = fold(q);
  for (const n of [...names].sort((a, b) => Number(!fold(a.name).startsWith(key)) - Number(!fold(b.name).startsWith(key)))) push(n.name, "product");
  if (out.length < SUGGEST_LIMIT) {
    const tags = await db.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT t AS "tag" FROM "Product" p, unnest(p."searchTags") t
      WHERE p."sellerId" = ${shop.id}::uuid AND p."deletedAt" IS NULL AND p."status" IN ('ON_SALE', 'SOLD_OUT') AND t ILIKE ANY(${patterns}::text[])
      ORDER BY t LIMIT 5`;
    for (const t of tags) push(t.tag, "tag");
  }
  return { suggestions: out };
}

// ───────── 파트너스: 유사어 묶음 ─────────
export type SynonymFailure = "invalid_synonyms" | "duplicate_word";
export const SYNONYM_MESSAGES: Record<SynonymFailure, string> = {
  invalid_synonyms: `유사어는 묶음당 ${SYNONYM_WORDS_MIN}~${SYNONYM_WORDS_MAX}개, 최대 ${SYNONYM_GROUP_MAX}묶음, 단어는 ${TAG_MAX_LENGTH}자 안으로 입력해 주십시오`,
  duplicate_word: "같은 단어를 여러 묶음에 넣을 수 없습니다",
};

// 조회는 같은 쇼핑몰 파트너스 계정 누구나
export async function listSynonyms(db: PrismaClient, ctx: TenantContext) {
  const rows = await db.shopSearchSynonym.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { words: true } });
  return { groups: rows.map((r) => ({ words: r.words })), canEdit: !ctx.readOnly && sellerCan(ctx, "PRODUCT_MANAGE") };
}

// 통째로 바꾼다. 본문 { groups: [{ words: [단어, …] }] }. 같은 단어(대소문자 무시)는 한 묶음에만. 상품 관리(PRODUCT_MANAGE) 권한.
export async function replaceSynonyms(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const list = raw && typeof raw === "object" ? (raw as { groups?: unknown }).groups : undefined;
  if (!Array.isArray(list) || list.length > SYNONYM_GROUP_MAX) return { ok: false as const, reason: "invalid_synonyms" as const };
  const groups: string[][] = [];
  const used = new Set<string>();
  for (const g of list) {
    const ws = g && typeof g === "object" ? (g as { words?: unknown }).words : undefined;
    if (!Array.isArray(ws) || ws.length > SYNONYM_WORDS_MAX * 2) return { ok: false as const, reason: "invalid_synonyms" as const };
    const words: string[] = [];
    const inGroup = new Set<string>();
    for (const w of ws) {
      const t = cleanText(w, TAG_MAX_LENGTH, "name");
      if (!t) return { ok: false as const, reason: "invalid_synonyms" as const };
      if (!inGroup.has(fold(t))) {
        inGroup.add(fold(t));
        words.push(t);
      }
    }
    if (words.length < SYNONYM_WORDS_MIN || words.length > SYNONYM_WORDS_MAX) return { ok: false as const, reason: "invalid_synonyms" as const };
    for (const k of inGroup) {
      if (used.has(k)) return { ok: false as const, reason: "duplicate_word" as const };
      used.add(k);
    }
    groups.push(words);
  }
  return db.$transaction(async (tx) => {
    const before = await tx.shopSearchSynonym.count({ where: { sellerId: ctx.sellerId } });
    await tx.shopSearchSynonym.deleteMany({ where: { sellerId: ctx.sellerId } });
    // 만든 순서가 곧 보이는 순서가 되도록 시각을 1ms씩 벌려 넣는다
    const base = Date.now();
    for (const [i, words] of groups.entries()) await tx.shopSearchSynonym.create({ data: { sellerId: ctx.sellerId, words, createdAt: new Date(base + i) } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop_search.synonyms.update", targetType: "ShopSearchSynonym", before: { groups: before }, after: { groups: groups.length }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, groups: groups.map((words) => ({ words })) };
  });
}
