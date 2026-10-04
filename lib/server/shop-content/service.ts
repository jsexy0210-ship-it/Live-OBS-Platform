import type { Prisma, PrismaClient, ShopBanner, ShopPopup, ShopPopupKind, ShopPopupTarget } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { deleteUnusedImages, imageVersion } from "./image";
import { normalizeLink, resolveLink } from "./link";

// 쇼핑몰 홈 배너(SA-064)·이벤트 팝업(SA-065)(2026-10-04 대표님 지시). 파트너스 관리자에서 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만 바꾸고
// 바꿀 때마다 감사 로그(화면 이름 「로그 추적」)를 남긴다. 구매자 화면 노출 여부는 DB 시계(now())로 판단한다.
export const BANNER_LIMIT = 10;
export const POPUP_LIMIT = 20;
export const TITLE_MAX = 40;
export const POPUP_BODY_MAX = 200;
export const LINK_LABEL_MAX = 20;
export const DEFAULT_LINK_LABEL = "자세히 보기";
// 「보지 않기」 선택지: 0=닫기만(매번 표시), 1=오늘 하루, 7=7일
export const DISMISS_DAYS = [0, 1, 7] as const;

export type ContentRejection =
  | "invalid_title"
  | "invalid_body"
  | "invalid_link"
  | "invalid_link_label"
  | "invalid_period"
  | "invalid_image"
  | "invalid_device"
  | "invalid_target"
  | "invalid_kind"
  | "invalid_dismiss"
  | "too_many"
  | "order_conflict";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const CONTENT_MESSAGES: Record<ContentRejection, string> = {
  invalid_title: `제목은 ${TITLE_MAX}자까지 입력할 수 있습니다`,
  invalid_body: `내용을 ${POPUP_BODY_MAX}자 안에서 입력해 주십시오`,
  invalid_link: "링크는 쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다",
  invalid_link_label: `버튼 이름은 ${LINK_LABEL_MAX}자까지 입력할 수 있습니다`,
  invalid_period: "종료 시각은 시작 시각보다 늦어야 합니다",
  invalid_image: "이미지를 올려 주십시오",
  invalid_device: "PC·모바일 중 하나 이상 선택해 주십시오",
  invalid_target: "노출 화면을 다시 선택해 주십시오",
  invalid_kind: "팝업 형태를 다시 선택해 주십시오",
  invalid_dismiss: "다시 보지 않기 기간을 다시 선택해 주십시오",
  too_many: "더 추가할 수 없습니다. 쓰지 않는 항목을 삭제해 주십시오",
  order_conflict: "다른 곳에서 목록이 바뀌었습니다. 새로고침한 뒤 다시 시도해 주십시오",
};

type Db = PrismaClient | Prisma.TransactionClient;
type Fail = { ok: false; reason: ContentRejection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// 시각은 시간대가 붙은 ISO 문자열만 받는다(서버 시간대에 따라 뜻이 바뀌지 않게). 화면은 KST(+09:00)로 보낸다.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function parseTime(v: unknown): Date | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !ISO.test(v)) return undefined;
  const d = new Date(v);
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 2000 || y > 2100 ? undefined : d;
}

function parsePeriod(b: Record<string, unknown>): { startsAt: Date | null; endsAt: Date | null } | null {
  const startsAt = parseTime(b.startsAt);
  const endsAt = parseTime(b.endsAt);
  if (startsAt === undefined || endsAt === undefined) return null;
  if (startsAt && endsAt && startsAt >= endsAt) return null;
  return { startsAt, endsAt };
}

// PC·모바일 표시(둘 다 끌 수 없음)
function parseDevices(b: Record<string, unknown>): { showOnPc: boolean; showOnMobile: boolean } | null {
  const showOnPc = bool(b.showOnPc, true);
  const showOnMobile = bool(b.showOnMobile, true);
  return showOnPc || showOnMobile ? { showOnPc, showOnMobile } : null;
}

const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

async function ownImage(db: Db, sellerId: string, id: unknown): Promise<boolean> {
  return isUuid(id) && !!(await db.shopContentImage.findFirst({ where: { id, sellerId }, select: { id: true } }));
}

// 기준 시각: DB 시계를 기간 칸(밀리초 정밀도)에 맞춰 밀리초로 자른 값. 마이크로초 그대로 비교하면 경계에서 판정이 흔들린다.
async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', now()) AS now`;
  return rows[0].now;
}

const lockSeller = (tx: Prisma.TransactionClient, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;

// ───────── 상태(화면 표시용) ─────────
export type ContentStatus = "live" | "scheduled" | "ended" | "hidden";
function statusOf(r: { isActive: boolean; startsAt: Date | null; endsAt: Date | null }, now: Date): ContentStatus {
  if (!r.isActive) return "hidden";
  if (r.startsAt && r.startsAt > now) return "scheduled";
  if (r.endsAt && r.endsAt <= now) return "ended";
  return "live";
}
const visibleWhere = (now: Date) => ({
  isActive: true,
  AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
});

type ImageRow = { id: string; width: number; height: number; sha256: string } | null;
const imageSelect = { select: { id: true, width: true, height: true, sha256: true } } as const;
const adminImage = (i: ImageRow) => (i ? { id: i.id, width: i.width, height: i.height, url: `/api/seller/shop-content/images/${i.id}?v=${imageVersion(i.sha256)}` } : null);
const publicImage = (slug: string, i: ImageRow) =>
  i ? { width: i.width, height: i.height, url: `/api/shop/${encodeURIComponent(slug)}/shop-content/images/${i.id}?v=${imageVersion(i.sha256)}` } : null;

// ───────── 배너 ─────────
type BannerInput = {
  title: string;
  pcImageId: string;
  mobileImageId: string | null;
  linkUrl: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  showOnPc: boolean;
  showOnMobile: boolean;
  isActive: boolean;
};

async function parseBanner(db: Db, sellerId: string, raw: unknown): Promise<{ ok: true; v: BannerInput } | Fail> {
  const b = obj(raw);
  const title = cleanText(b.title, TITLE_MAX, "memo");
  if (!title) return { ok: false, reason: "invalid_title" };
  const link = normalizeLink(b.linkUrl);
  if (!link.ok) return { ok: false, reason: "invalid_link" };
  const period = parsePeriod(b);
  if (!period) return { ok: false, reason: "invalid_period" };
  const devices = parseDevices(b);
  if (!devices) return { ok: false, reason: "invalid_device" };
  const mobileImageId = b.mobileImageId === null || b.mobileImageId === undefined || b.mobileImageId === "" ? null : b.mobileImageId;
  if (!(await ownImage(db, sellerId, b.pcImageId)) || (mobileImageId !== null && !(await ownImage(db, sellerId, mobileImageId)))) {
    return { ok: false, reason: "invalid_image" };
  }
  return {
    ok: true,
    v: { title, pcImageId: b.pcImageId as string, mobileImageId: mobileImageId as string | null, linkUrl: link.value, ...period, ...devices, isActive: bool(b.isActive, true) },
  };
}

const bannerInclude = { pcImage: imageSelect, mobileImage: imageSelect } as const;
type BannerRow = ShopBanner & { pcImage: ImageRow & object; mobileImage: ImageRow };

function bannerView(r: BannerRow, now: Date) {
  return {
    id: r.id,
    title: r.title,
    pcImage: adminImage(r.pcImage),
    mobileImage: adminImage(r.mobileImage),
    linkUrl: r.linkUrl,
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    showOnPc: r.showOnPc,
    showOnMobile: r.showOnMobile,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    status: statusOf(r, now),
  };
}
export type BannerView = ReturnType<typeof bannerView>;

// 감사 로그용 값(이미지 바이트·주소 없이 id만)
const bannerAudit = (r: ShopBanner) => ({
  title: r.title,
  pcImageId: r.pcImageId,
  mobileImageId: r.mobileImageId,
  linkUrl: r.linkUrl,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  showOnPc: r.showOnPc,
  showOnMobile: r.showOnMobile,
  isActive: r.isActive,
  sortOrder: r.sortOrder,
});

export async function listBanners(db: PrismaClient, ctx: TenantContext) {
  // 조회는 같은 쇼핑몰의 파트너스 계정이면 누구나(보기만, MASTER 결정 2026-10-04). 바꾸기는 대표자·SHOP_SETTINGS만.
  const [now, rows] = await Promise.all([
    dbNow(db),
    db.shopBanner.findMany({ where: { sellerId: ctx.sellerId }, include: bannerInclude, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  return rows.map((r) => bannerView(r as BannerRow, now));
}

export async function createBanner(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const p = await parseBanner(tx, ctx.sellerId, raw);
    if (!p.ok) return p;
    const count = await tx.shopBanner.count({ where: { sellerId: ctx.sellerId } });
    if (count >= BANNER_LIMIT) return { ok: false as const, reason: "too_many" as const };
    const last = await tx.shopBanner.aggregate({ where: { sellerId: ctx.sellerId }, _max: { sortOrder: true } });
    const row = await tx.shopBanner.create({ data: { sellerId: ctx.sellerId, ...p.v, sortOrder: (last._max.sortOrder ?? -1) + 1 }, include: bannerInclude });
    await audit(tx, ctx, meta, "shop.banner.create", "ShopBanner", row.id, undefined, bannerAudit(row));
    return { ok: true as const, banner: bannerView(row as BannerRow, await dbNow(tx)) };
  });
}

export async function updateBanner(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopBanner.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    const p = await parseBanner(tx, ctx.sellerId, raw);
    if (!p.ok) return p;
    const row = await tx.shopBanner.update({ where: { id }, data: p.v, include: bannerInclude });
    await deleteUnusedImages(tx, ctx.sellerId, [before.pcImageId, before.mobileImageId]);
    await audit(tx, ctx, meta, "shop.banner.update", "ShopBanner", id, bannerAudit(before), bannerAudit(row));
    return { ok: true as const, banner: bannerView(row as BannerRow, await dbNow(tx)) };
  });
}

export async function deleteBanner(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) throw notFound();
  await db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopBanner.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    await tx.shopBanner.delete({ where: { id } });
    await deleteUnusedImages(tx, ctx.sellerId, [before.pcImageId, before.mobileImageId]);
    await audit(tx, ctx, meta, "shop.banner.delete", "ShopBanner", id, bannerAudit(before), undefined);
  });
}

// ───────── 팝업 ─────────
type PopupInput = {
  kind: ShopPopupKind;
  title: string;
  body: string | null;
  imageId: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  target: ShopPopupTarget;
  showOnPc: boolean;
  showOnMobile: boolean;
  dismissDays: number;
  isActive: boolean;
};

// 형태별: 이미지 팝업은 이미지 필수(내용은 선택), 글 팝업은 내용 필수(이미지 없음), 상단 띠는 제목 한 줄과 링크만(이미지·내용 없음).
async function parsePopup(db: Db, sellerId: string, raw: unknown): Promise<{ ok: true; v: PopupInput } | Fail> {
  const b = obj(raw);
  const kind = b.kind === undefined ? "IMAGE" : b.kind;
  if (kind !== "IMAGE" && kind !== "TEXT" && kind !== "BAR") return { ok: false, reason: "invalid_kind" };
  const title = cleanText(b.title, TITLE_MAX, "memo");
  if (!title) return { ok: false, reason: "invalid_title" };
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  let body: string | null = null;
  if (kind !== "BAR" && !empty(b.body)) {
    body = cleanText(b.body, POPUP_BODY_MAX, "multiline");
    if (!body) return { ok: false, reason: "invalid_body" };
  }
  if (kind === "TEXT" && !body) return { ok: false, reason: "invalid_body" };
  const link = normalizeLink(b.linkUrl);
  if (!link.ok) return { ok: false, reason: "invalid_link" };
  let linkLabel: string | null = null;
  if (link.value && kind !== "BAR" && !empty(b.linkLabel)) {
    linkLabel = cleanText(b.linkLabel, LINK_LABEL_MAX, "name");
    if (!linkLabel) return { ok: false, reason: "invalid_link_label" };
  }
  const period = parsePeriod(b);
  if (!period) return { ok: false, reason: "invalid_period" };
  const target = b.target === undefined ? "HOME" : b.target;
  if (target !== "HOME" && target !== "ALL") return { ok: false, reason: "invalid_target" };
  const devices = parseDevices(b);
  if (!devices) return { ok: false, reason: "invalid_device" };
  const dismissDays = b.dismissDays === undefined ? 1 : b.dismissDays;
  if (!(DISMISS_DAYS as readonly unknown[]).includes(dismissDays)) return { ok: false, reason: "invalid_dismiss" };
  const imageId = kind === "IMAGE" && !empty(b.imageId) ? b.imageId : null;
  if (kind === "IMAGE" && (imageId === null || !(await ownImage(db, sellerId, imageId)))) return { ok: false, reason: "invalid_image" };
  return {
    ok: true,
    v: {
      kind,
      title,
      body,
      imageId: imageId as string | null,
      linkUrl: link.value,
      linkLabel,
      ...period,
      target,
      ...devices,
      dismissDays: dismissDays as number,
      isActive: bool(b.isActive, true),
    },
  };
}

type PopupRow = ShopPopup & { image: ImageRow };

function popupView(r: PopupRow, now: Date) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    image: adminImage(r.image),
    linkUrl: r.linkUrl,
    linkLabel: r.linkLabel,
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    target: r.target,
    showOnPc: r.showOnPc,
    showOnMobile: r.showOnMobile,
    dismissDays: r.dismissDays,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    status: statusOf(r, now),
  };
}
export type PopupView = ReturnType<typeof popupView>;

const popupAudit = (r: ShopPopup) => ({
  kind: r.kind,
  title: r.title,
  body: r.body,
  imageId: r.imageId,
  linkUrl: r.linkUrl,
  linkLabel: r.linkLabel,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  target: r.target,
  showOnPc: r.showOnPc,
  showOnMobile: r.showOnMobile,
  dismissDays: r.dismissDays,
  isActive: r.isActive,
  sortOrder: r.sortOrder,
});

export async function listPopups(db: PrismaClient, ctx: TenantContext) {
  // 조회는 같은 쇼핑몰의 파트너스 계정이면 누구나(보기만, MASTER 결정 2026-10-04). 바꾸기는 대표자·SHOP_SETTINGS만.
  const [now, rows] = await Promise.all([
    dbNow(db),
    db.shopPopup.findMany({ where: { sellerId: ctx.sellerId }, include: { image: imageSelect }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  return rows.map((r) => popupView(r, now));
}

export async function createPopup(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const p = await parsePopup(tx, ctx.sellerId, raw);
    if (!p.ok) return p;
    const count = await tx.shopPopup.count({ where: { sellerId: ctx.sellerId } });
    if (count >= POPUP_LIMIT) return { ok: false as const, reason: "too_many" as const };
    const last = await tx.shopPopup.aggregate({ where: { sellerId: ctx.sellerId }, _max: { sortOrder: true } });
    const row = await tx.shopPopup.create({ data: { sellerId: ctx.sellerId, ...p.v, sortOrder: (last._max.sortOrder ?? -1) + 1 }, include: { image: imageSelect } });
    await audit(tx, ctx, meta, "shop.popup.create", "ShopPopup", row.id, undefined, popupAudit(row));
    return { ok: true as const, popup: popupView(row, await dbNow(tx)) };
  });
}

export async function updatePopup(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopPopup.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    const p = await parsePopup(tx, ctx.sellerId, raw);
    if (!p.ok) return p;
    const row = await tx.shopPopup.update({ where: { id }, data: p.v, include: { image: imageSelect } });
    await deleteUnusedImages(tx, ctx.sellerId, [before.imageId]);
    await audit(tx, ctx, meta, "shop.popup.update", "ShopPopup", id, popupAudit(before), popupAudit(row));
    return { ok: true as const, popup: popupView(row, await dbNow(tx)) };
  });
}

export async function deletePopup(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) throw notFound();
  await db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopPopup.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    await tx.shopPopup.delete({ where: { id } });
    await deleteUnusedImages(tx, ctx.sellerId, [before.imageId]);
    await audit(tx, ctx, meta, "shop.popup.delete", "ShopPopup", id, popupAudit(before), undefined);
  });
}

// ───────── 순서 바꾸기(끌어서 변경) ─────────
// 본문 { ids: [...] }는 지금 있는 항목 전체를 빠짐없이 한 번씩 담아야 한다(다른 곳에서 추가·삭제했으면 409 order_conflict).
export async function reorder(db: PrismaClient, ctx: TenantContext, kind: "banner" | "popup", raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const ids = obj(raw).ids;
  if (!Array.isArray(ids) || !ids.every(isUuid)) return { ok: false as const, reason: "order_conflict" as const };
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const model = kind === "banner" ? tx.shopBanner : tx.shopPopup;
    const rows: { id: string }[] = await (model as typeof tx.shopBanner).findMany({
      where: { sellerId: ctx.sellerId },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const current = rows.map((r) => r.id);
    const next = ids as string[];
    if (next.length !== current.length || new Set(next).size !== next.length || !next.every((id) => current.includes(id))) {
      return { ok: false as const, reason: "order_conflict" as const };
    }
    for (const [i, id] of next.entries()) {
      await (model as typeof tx.shopBanner).updateMany({ where: { id, sellerId: ctx.sellerId }, data: { sortOrder: i } });
    }
    const type = kind === "banner" ? "ShopBanner" : "ShopPopup";
    await audit(tx, ctx, meta, `shop.${kind}.reorder`, type, ctx.sellerId, { ids: current }, { ids: next });
    return { ok: true as const };
  });
}

// ───────── 구매자 화면 ─────────
export type ShopPage = "home" | "other";

// 지금 보여 줄 배너·팝업(운영 중이고 스토어 운영 권한이 있는 쇼핑몰만, 아니면 null). 기간은 DB 시계로 판단한다.
// 배너는 홈에서만, 팝업은 홈이면 HOME·ALL, 그 밖 화면이면 ALL만. PC·모바일 구분은 화면 너비(768px)로 브라우저가 한다.
export async function visibleShopContent(db: PrismaClient, slug: string, page: ShopPage) {
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true, slug: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const now = await dbNow(db);
  const [banners, popups] = await Promise.all([
    page === "home"
      ? db.shopBanner.findMany({ where: { sellerId: shop.id, ...visibleWhere(now) }, include: bannerInclude, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
      : Promise.resolve([]),
    db.shopPopup.findMany({
      where: { sellerId: shop.id, ...visibleWhere(now), ...(page === "home" ? {} : { target: "ALL" as const }) },
      include: { image: imageSelect },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  return {
    banners: banners.map((b) => ({
      id: b.id,
      title: b.title,
      link: resolveLink(shop.slug, b.linkUrl),
      pcImage: publicImage(shop.slug, b.pcImage)!,
      mobileImage: publicImage(shop.slug, b.mobileImage),
      showOnPc: b.showOnPc,
      showOnMobile: b.showOnMobile,
    })),
    popups: popups.map((p) => ({
      id: p.id,
      kind: p.kind,
      title: p.title,
      body: p.body,
      image: publicImage(shop.slug, p.image),
      link: resolveLink(shop.slug, p.linkUrl),
      linkLabel: p.linkUrl ? (p.linkLabel ?? DEFAULT_LINK_LABEL) : null,
      showOnPc: p.showOnPc,
      showOnMobile: p.showOnMobile,
      dismissDays: p.dismissDays,
      // 구매자에게 보이는 내용이 바뀌면 「보지 않기」를 다시 묻도록 저장 키에 넣는다. 순서·기간·노출 스위치만 바꾼 것은 버전을 바꾸지 않는다.
      version: popupContentVersion(p),
    })),
  };
}
export type VisibleShopContent = NonNullable<Awaited<ReturnType<typeof visibleShopContent>>>;

// 팝업 내용 버전(구매자 브라우저의 「보지 않기」 저장 키). updatedAt은 순서 바꾸기에도 바뀌므로 쓰지 않는다.
function popupContentVersion(p: ShopPopup): string {
  const content = [p.kind, p.title, p.body, p.imageId, p.linkUrl, p.linkLabel, p.target, p.showOnPc, p.showOnMobile, p.dismissDays];
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12);
}

// 공개 이미지: 운영 중인 쇼핑몰의 이미지 중 지금 보이는 배너·팝업이 쓰는 것만 준다(예약·종료·숨김 항목의 이미지는 404).
export async function publicShopImage(db: PrismaClient, slug: string, imageId: string) {
  if (!isUuid(imageId)) return null;
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const now = await dbNow(db);
  const used =
    (await db.shopBanner.count({ where: { sellerId: shop.id, ...visibleWhere(now), OR: [{ pcImageId: imageId }, { mobileImageId: imageId }] } })) > 0 ||
    (await db.shopPopup.count({ where: { sellerId: shop.id, ...visibleWhere(now), imageId } })) > 0;
  if (!used) return null;
  return db.shopContentImage.findFirst({ where: { id: imageId, sellerId: shop.id }, select: { data: true, contentType: true, sha256: true } });
}

// 파트너스 관리자 미리보기용 이미지(아직 저장하지 않은 이미지 포함). 같은 쇼핑몰 계정만, 다른 쇼핑몰 이미지는 404.
export async function sellerShopImage(db: PrismaClient, ctx: TenantContext, imageId: string) {
  // 조회는 같은 쇼핑몰의 파트너스 계정이면 누구나(보기만, MASTER 결정 2026-10-04). 바꾸기는 대표자·SHOP_SETTINGS만.
  if (!isUuid(imageId)) throw notFound();
  const row = await db.shopContentImage.findFirst({ where: { id: imageId, sellerId: ctx.sellerId }, select: { data: true, contentType: true, sha256: true } });
  if (!row) throw notFound();
  return row;
}

// ───────── 감사 로그 ─────────
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

function audit(tx: Prisma.TransactionClient, ctx: TenantContext, meta: AuditMeta, action: string, targetType: string, targetId: string, before: unknown, after: unknown) {
  return writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType, targetId, before, after, ip: meta.ip, userAgent: meta.userAgent });
}
