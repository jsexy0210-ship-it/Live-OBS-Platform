import { Prisma, type PrismaClient, type ServiceVendorCategory } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { AdminSessionContext } from "../auth/session";
import { checkVendorLogo, type ImageRejection } from "../branding/image";
import { imageHash } from "../branding/store";
import { cleanText } from "../text/clean";

// 외부 서비스 업체 등록·비교(마스터 관리자 설정 > 외부 서비스 연동, docs/COST_POLICY.md 「외부 서비스 업체 선택」).
// - 분야(PG·SHIPPING·TRACKING)별 업체 목록, 분야마다 「추천」 1개와 「선택된 업체」 1개. 추천·가중치는 코드에 고정하지 않고 마스터 관리자가 바꾼다.
// - 점수(0~100) = Σ(가중치 × 평가 0~10) ÷ (10 × Σ가중치) × 100(소수 첫째 자리). 평가 항목 중 하나라도 비어 있으면 점수는 null(평가 중).
// - 요금(referenceFee)은 공개 기준 참고값(글)이다. 실제 외부 API 연동·계약은 하지 않는다.
// - 조회는 마스터 관리자 누구나(platform.read는 가드가 확인), 변경은 vendor.manage(최고관리자·운영)이고 모두 로그 추적에 남긴다.
// - 업체는 지우지 않고 사용 안 함(active=false)으로 둔다. 추천·선택 중인 업체는 사용 안 함으로 바꿀 수 없다.
export const VENDOR_CATEGORIES = ["PG", "SHIPPING", "TRACKING"] as const satisfies readonly ServiceVendorCategory[];
export const isVendorCategory = (v: unknown): v is ServiceVendorCategory => typeof v === "string" && (VENDOR_CATEGORIES as readonly string[]).includes(v);

const PG_CRITERIA = ["fee", "setupFee", "recurring", "methods", "api", "stability", "settlement"] as const;
const SHIPPING_CRITERIA = ["invoiceIssue", "invoicePrint", "tracking", "carrierCoverage", "returns", "cost", "api"] as const;
export const CRITERIA: Record<ServiceVendorCategory, readonly string[]> = { PG: PG_CRITERIA, SHIPPING: SHIPPING_CRITERIA, TRACKING: SHIPPING_CRITERIA };

// 초기 가중치(docs/COST_POLICY.md, 마이그레이션이 같은 값을 넣는다). 설정 행이 없을 때의 기본값이기도 하다. 배송조회 분야는 배송 가중치를 쓴다.
export const DEFAULT_WEIGHTS: Record<ServiceVendorCategory, Record<string, number>> = {
  PG: { fee: 30, setupFee: 15, recurring: 15, methods: 15, api: 10, stability: 10, settlement: 5 },
  SHIPPING: { invoiceIssue: 20, invoicePrint: 15, tracking: 20, carrierCoverage: 15, returns: 10, cost: 10, api: 10 },
  TRACKING: { invoiceIssue: 20, invoicePrint: 15, tracking: 20, carrierCoverage: 15, returns: 10, cost: 10, api: 10 },
};

// 기능 지원 항목 키(화면이 이름을 붙인다). 분야별로 정해진 키만 받는다.
export const FEATURE_KEYS: Record<ServiceVendorCategory, readonly string[]> = {
  PG: ["card", "bankTransfer", "virtualAccount", "easyPay", "recurring", "escrow", "cashReceipt"],
  SHIPPING: ["invoiceIssue", "invoicePrint", "tracking", "returns", "multiCarrier", "apiSandbox"],
  TRACKING: ["tracking", "multiCarrier", "linkOnly"],
};

export const VENDOR_NAME_MAX = 40;
export const VENDOR_FEE_MAX = 200;
export const VENDOR_MEMO_MAX = 500;
export const RATING_MAX = 10;

export const VENDOR_MESSAGES = {
  invalid_vendor: `업체 이름은 ${VENDOR_NAME_MAX}자, 요금 참고값은 ${VENDOR_FEE_MAX}자, 메모는 ${VENDOR_MEMO_MAX}자까지 쓸 수 있고, 기능 항목과 평가 항목(0~${RATING_MAX}점)은 정해진 값만 쓸 수 있습니다`,
  invalid_weights: "가중치는 모든 평가 항목에 0~100 사이 정수로 넣어야 하고, 합이 0보다 커야 합니다",
  invalid_selection: "같은 분야의 사용 중인 업체만 추천·선택할 수 있습니다",
  duplicate_vendor: "같은 분야에 같은 이름의 업체가 있습니다",
  vendor_in_use: "추천 또는 선택 중인 업체는 사용 안 함으로 바꿀 수 없습니다. 먼저 다른 업체로 바꿔 주십시오",
  not_found: "업체를 찾을 수 없습니다",
  file_too_large: "로고는 256KB 이하 PNG만 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다. 파일이 손상되었는지 확인해 주십시오",
  wrong_image_size: "로고는 가로·세로 각각 16~600px이어야 합니다",
  empty_file: "파일이 비어 있습니다",
} as const;
export type VendorReason = keyof typeof VENDOR_MESSAGES;
export const VENDOR_STATUS: Record<VendorReason, number> = {
  invalid_vendor: 400,
  invalid_weights: 400,
  invalid_selection: 400,
  duplicate_vendor: 409,
  vendor_in_use: 409,
  not_found: 404,
  file_too_large: 413,
  unsupported_image: 400,
  wrong_image_size: 400,
  empty_file: 400,
};

type Meta = { ip?: string | null; userAgent?: string | null };
type Tx = Prisma.TransactionClient;
type Ratings = Record<string, number>;

function requireEditor(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "vendor.manage")) throw forbidden();
}

const lockCategory = (tx: Tx, category: ServiceVendorCategory) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`service_vendor:${category}`}))`;

function asRatings(v: unknown): Ratings {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Ratings) : {};
}

export function vendorScore(ratings: Ratings, weights: Record<string, number>, category: ServiceVendorCategory): number | null {
  const keys = CRITERIA[category];
  let sum = 0;
  let total = 0;
  for (const k of keys) {
    const r = ratings[k];
    if (typeof r !== "number") return null;
    sum += (weights[k] ?? 0) * r;
    total += weights[k] ?? 0;
  }
  if (total <= 0) return null;
  return Math.round((sum / (RATING_MAX * total)) * 1000) / 10;
}

type VendorRow = {
  id: string;
  category: ServiceVendorCategory;
  name: string;
  features: string[];
  referenceFee: string | null;
  memo: string | null;
  ratings: Prisma.JsonValue;
  active: boolean;
  updatedAt: Date;
  logo: { hash: string } | null;
};
const VENDOR_SELECT = { id: true, category: true, name: true, features: true, referenceFee: true, memo: true, ratings: true, active: true, updatedAt: true, logo: { select: { hash: true } } } as const;

const logoUrl = (v: { id: string; logo: { hash: string } | null }) => (v.logo ? `/api/admin/service-vendors/${v.id}/logo?v=${v.logo.hash}` : null);

function vendorView(v: VendorRow, weights: Record<string, number>, setting: { recommendedVendorId: string | null; selectedVendorId: string | null }) {
  const ratings = asRatings(v.ratings);
  return {
    id: v.id,
    category: v.category,
    name: v.name,
    features: v.features,
    referenceFee: v.referenceFee,
    memo: v.memo,
    ratings,
    ratedCount: CRITERIA[v.category].filter((k) => typeof ratings[k] === "number").length,
    score: vendorScore(ratings, weights, v.category),
    active: v.active,
    logoUrl: logoUrl(v),
    recommended: setting.recommendedVendorId === v.id,
    selected: setting.selectedVendorId === v.id,
    updatedAt: v.updatedAt,
  };
}

async function settingOf(db: PrismaClient | Tx, category: ServiceVendorCategory) {
  const s = await db.serviceVendorSetting.findUnique({ where: { category } });
  const weights = (s?.weights && typeof s.weights === "object" ? s.weights : DEFAULT_WEIGHTS[category]) as Record<string, number>;
  return { weights, recommendedVendorId: s?.recommendedVendorId ?? null, selectedVendorId: s?.selectedVendorId ?? null };
}

async function categoryView(db: PrismaClient | Tx, category: ServiceVendorCategory) {
  const setting = await settingOf(db, category);
  const rows = await db.serviceVendor.findMany({ where: { category }, select: VENDOR_SELECT, orderBy: [{ createdAt: "asc" }, { name: "asc" }] });
  return {
    category,
    criteria: CRITERIA[category].map((key) => ({ key, weight: setting.weights[key] ?? 0 })),
    featureKeys: FEATURE_KEYS[category],
    recommendedVendorId: setting.recommendedVendorId,
    selectedVendorId: setting.selectedVendorId,
    vendors: rows.map((r) => vendorView(r, setting.weights, setting)),
  };
}

// 조회: category를 주면 그 분야만, 아니면 세 분야 모두.
export async function listServiceVendors(db: PrismaClient, category?: ServiceVendorCategory) {
  const cats = category ? [category] : [...VENDOR_CATEGORIES];
  return { categories: await Promise.all(cats.map((c) => categoryView(db, c))) };
}

// 글 값: null·빈 문자열 → null, 통과 → 정리한 값, 위반 → undefined
function text(v: unknown, max: number, kind: "name" | "memo"): string | null | undefined {
  if (v === null || v === "") return null;
  return cleanText(v, max, kind) ?? undefined;
}

function parseFeatures(category: ServiceVendorCategory, v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > FEATURE_KEYS[category].length) return undefined;
  if (v.some((k) => typeof k !== "string" || !FEATURE_KEYS[category].includes(k))) return undefined;
  return [...new Set(v as string[])];
}

// 평가 값 병합: 키 → 0~10 정수(올림 없음), null이면 그 항목을 지운다.
function mergeRatings(category: ServiceVendorCategory, current: Ratings, v: unknown): Ratings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const next = { ...current };
  for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
    if (!CRITERIA[category].includes(k)) return undefined;
    if (r === null) delete next[k];
    else if (typeof r === "number" && Number.isInteger(r) && r >= 0 && r <= RATING_MAX) next[k] = r;
    else return undefined;
  }
  return next;
}

const FIELDS = ["name", "features", "referenceFee", "memo", "ratings", "active"] as const;

type Parsed = { name?: string; features?: string[]; referenceFee?: string | null; memo?: string | null; ratings?: Ratings; active?: boolean };

function parseFields(category: ServiceVendorCategory, current: Ratings, b: Record<string, unknown>): Parsed | undefined {
  const out: Parsed = {};
  if (b.name !== undefined) {
    const n = text(b.name, VENDOR_NAME_MAX, "name");
    if (typeof n !== "string") return undefined;
    out.name = n;
  }
  if (b.features !== undefined) {
    const f = parseFeatures(category, b.features);
    if (!f) return undefined;
    out.features = f;
  }
  if (b.referenceFee !== undefined) {
    const f = text(b.referenceFee, VENDOR_FEE_MAX, "memo");
    if (f === undefined) return undefined;
    out.referenceFee = f;
  }
  if (b.memo !== undefined) {
    const m = text(b.memo, VENDOR_MEMO_MAX, "memo");
    if (m === undefined) return undefined;
    out.memo = m;
  }
  if (b.ratings !== undefined) {
    const r = mergeRatings(category, current, b.ratings);
    if (!r) return undefined;
    out.ratings = r;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") return undefined;
    out.active = b.active;
  }
  return out;
}

const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);
const snapshot = (v: { name: string; features: string[]; referenceFee: string | null; memo: string | null; ratings: Prisma.JsonValue; active: boolean }) => ({
  name: v.name,
  features: v.features,
  referenceFee: v.referenceFee,
  memo: v.memo,
  ratings: asRatings(v.ratings),
  active: v.active,
});

// 업체 등록. 본문: { category, name, features?, referenceFee?, memo?, ratings?, active? }.
export async function createServiceVendor(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: Meta = {}) {
  requireEditor(admin);
  const b = obj(raw);
  if (!b || !isVendorCategory(b.category) || b.name === undefined || Object.keys(b).some((k) => k !== "category" && !(FIELDS as readonly string[]).includes(k))) {
    return { ok: false as const, reason: "invalid_vendor" as const };
  }
  const category = b.category;
  const f = parseFields(category, {}, b);
  if (!f || f.name === undefined) return { ok: false as const, reason: "invalid_vendor" as const };
  return db.$transaction(async (tx) => {
    await lockCategory(tx, category);
    if (await tx.serviceVendor.findUnique({ where: { category_name: { category, name: f.name! } }, select: { id: true } })) return { ok: false as const, reason: "duplicate_vendor" as const };
    const v = await tx.serviceVendor.create({ data: { category, name: f.name!, features: f.features, referenceFee: f.referenceFee, memo: f.memo, ratings: f.ratings ?? {}, active: f.active ?? true }, select: VENDOR_SELECT });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "service_vendor.create", targetType: "ServiceVendor", targetId: v.id, before: null, after: { category, ...snapshot(v) }, ip: meta.ip, userAgent: meta.userAgent });
    const setting = await settingOf(tx, category);
    return { ok: true as const, vendor: vendorView(v, setting.weights, setting) };
  });
}

// 업체 수정(보낸 키만). 분야는 바꿀 수 없다. 평가는 키별로 병합(null이면 그 항목 지움).
export async function updateServiceVendor(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: Meta = {}) {
  requireEditor(admin);
  const b = obj(raw);
  if (!b || Object.keys(b).length === 0 || Object.keys(b).some((k) => !(FIELDS as readonly string[]).includes(k))) return { ok: false as const, reason: "invalid_vendor" as const };
  const head = isUuid(id) ? await db.serviceVendor.findUnique({ where: { id }, select: { category: true } }) : null;
  if (!head) return { ok: false as const, reason: "not_found" as const };
  const category = head.category;
  return db.$transaction(async (tx) => {
    await lockCategory(tx, category);
    const cur = await tx.serviceVendor.findUnique({ where: { id }, select: VENDOR_SELECT });
    if (!cur) return { ok: false as const, reason: "not_found" as const };
    const f = parseFields(category, asRatings(cur.ratings), b);
    if (!f) return { ok: false as const, reason: "invalid_vendor" as const };
    const setting = await settingOf(tx, category);
    if (f.active === false && (setting.recommendedVendorId === id || setting.selectedVendorId === id)) return { ok: false as const, reason: "vendor_in_use" as const };
    if (f.name !== undefined && f.name !== cur.name && (await tx.serviceVendor.findUnique({ where: { category_name: { category, name: f.name } }, select: { id: true } }))) {
      return { ok: false as const, reason: "duplicate_vendor" as const };
    }
    const before = snapshot(cur);
    const v = await tx.serviceVendor.update({ where: { id }, data: { ...f, ratings: f.ratings }, select: VENDOR_SELECT });
    const after = snapshot(v);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "service_vendor.update", targetType: "ServiceVendor", targetId: id, before, after, ip: meta.ip, userAgent: meta.userAgent });
    }
    return { ok: true as const, vendor: vendorView(v, setting.weights, setting) };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// 분야 설정. 본문: { weights?: { 평가 항목: 0~100 정수(모든 항목) }, recommendedVendorId?: uuid | null, selectedVendorId?: uuid | null }.
// 추천·선택은 같은 분야의 사용 중인 업체만. 보낸 키만 바꾼다.
export async function updateServiceVendorCategory(db: PrismaClient, admin: AdminSessionContext, category: ServiceVendorCategory, raw: unknown, meta: Meta = {}) {
  requireEditor(admin);
  const b = obj(raw);
  const keys = b ? Object.keys(b) : [];
  if (!b || keys.length === 0 || keys.some((k) => !["weights", "recommendedVendorId", "selectedVendorId"].includes(k))) return { ok: false as const, reason: "invalid_selection" as const };
  let weights: Record<string, number> | undefined;
  if (b.weights !== undefined) {
    const w = obj(b.weights);
    const crit = CRITERIA[category];
    if (!w || Object.keys(w).length !== crit.length || !crit.every((k) => typeof w[k] === "number" && Number.isInteger(w[k]) && (w[k] as number) >= 0 && (w[k] as number) <= 100)) {
      return { ok: false as const, reason: "invalid_weights" as const };
    }
    if (crit.reduce((a, k) => a + (w[k] as number), 0) <= 0) return { ok: false as const, reason: "invalid_weights" as const };
    weights = Object.fromEntries(crit.map((k) => [k, w[k] as number]));
  }
  for (const k of ["recommendedVendorId", "selectedVendorId"] as const) {
    if (b[k] !== undefined && b[k] !== null && !isUuid(b[k])) return { ok: false as const, reason: "invalid_selection" as const };
  }
  return db.$transaction(async (tx) => {
    await lockCategory(tx, category);
    const before = await settingOf(tx, category);
    for (const k of ["recommendedVendorId", "selectedVendorId"] as const) {
      const id = b[k];
      if (typeof id === "string" && !(await tx.serviceVendor.findFirst({ where: { id, category, active: true }, select: { id: true } }))) return { ok: false as const, reason: "invalid_selection" as const };
    }
    const next = {
      weights: weights ?? before.weights,
      recommendedVendorId: b.recommendedVendorId === undefined ? before.recommendedVendorId : (b.recommendedVendorId as string | null),
      selectedVendorId: b.selectedVendorId === undefined ? before.selectedVendorId : (b.selectedVendorId as string | null),
    };
    await tx.serviceVendorSetting.upsert({ where: { category }, create: { category, ...next }, update: next });
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "service_vendor.category.update", targetType: "ServiceVendorSetting", targetId: category, before, after: next, ip: meta.ip, userAgent: meta.userAgent });
    }
    return { ok: true as const, category: await categoryView(tx, category) };
  });
}

// 로고 올리기(PNG, 256KB, 16~600px). 형식은 파일 앞부분 바이트와 그림 데이터로 확인한다. 로그 추적에는 형식·크기·해시만 남긴다.
export async function setServiceVendorLogo(db: PrismaClient, admin: AdminSessionContext, id: string, data: Buffer, meta: Meta = {}) {
  requireEditor(admin);
  const check = checkVendorLogo(data);
  if (!check.ok) return { ok: false as const, reason: check.reason as ImageRejection | "empty_file" };
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const hash = imageHash(data);
  const bytes = new Uint8Array(data);
  return db.$transaction(async (tx) => {
    const v = await tx.serviceVendor.findUnique({ where: { id }, select: { id: true, category: true } });
    if (!v) return { ok: false as const, reason: "not_found" as const };
    await lockCategory(tx, v.category);
    const before = await tx.serviceVendorLogo.findUnique({ where: { vendorId: id }, select: { type: true, hash: true, data: true } });
    await tx.serviceVendorLogo.upsert({ where: { vendorId: id }, create: { vendorId: id, data: bytes, type: check.info.type, hash }, update: { data: bytes, type: check.info.type, hash } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "service_vendor.logo.set",
      targetType: "ServiceVendor",
      targetId: id,
      before: before && { type: before.type, bytes: before.data.length, hash: before.hash },
      after: { type: check.info.type, bytes: data.length, hash, width: check.info.width, height: check.info.height },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, logoUrl: `/api/admin/service-vendors/${id}/logo?v=${hash}` };
  });
}

// 로고 지우기(첫 글자 표시로 돌아감). 지울 것이 없어도 성공, 로그는 실제로 지웠을 때만.
export async function removeServiceVendorLogo(db: PrismaClient, admin: AdminSessionContext, id: string, meta: Meta = {}) {
  requireEditor(admin);
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const v = await tx.serviceVendor.findUnique({ where: { id }, select: { id: true, category: true } });
    if (!v) return { ok: false as const, reason: "not_found" as const };
    await lockCategory(tx, v.category);
    const before = await tx.serviceVendorLogo.findUnique({ where: { vendorId: id }, select: { type: true, hash: true, data: true } });
    if (before) {
      await tx.serviceVendorLogo.delete({ where: { vendorId: id } });
      await writeAudit(tx, {
        actorType: "PLATFORM_ADMIN",
        actorId: admin.admin.id,
        action: "service_vendor.logo.remove",
        targetType: "ServiceVendor",
        targetId: id,
        before: { type: before.type, bytes: before.data.length, hash: before.hash },
        after: null,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return { ok: true as const, logoUrl: null };
  });
}

export async function readServiceVendorLogo(db: PrismaClient, id: string) {
  if (!isUuid(id)) return null;
  const l = await db.serviceVendorLogo.findUnique({ where: { vendorId: id } });
  return l ? { data: Buffer.from(l.data), type: l.type, hash: l.hash } : null;
}
