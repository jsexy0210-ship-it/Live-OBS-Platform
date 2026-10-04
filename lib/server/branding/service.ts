import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { adminCan } from "../authz/permissions";
import { forbidden } from "../authz/errors";
import { cleanText } from "../text/clean";
import { checkFavicon, checkOgImage, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, type ImageRejection } from "./image";
import { imageHash, readImage, removeImage, writeImage, type BrandingTarget, type ImageSlot } from "./store";

// 관리자 화면 브랜딩(대표님 요구 2026-10-04): 마스터 관리자·파트너스 관리자 화면 각각의 파비콘과 공유 카드(제목·설명·이미지).
// 공유 카드 이미지는 직접 올린 1200×630 이미지가 있으면 그것, 없으면 제목으로 서버가 그린 카드(card.ts)를 쓴다.
// 바꾸기는 최고관리자만(system.manage), 보기는 마스터 관리자 전체(platform.read). 바꿀 때마다 감사 로그를 남긴다.

export const BRANDING_TITLE_MAX = 60;
export const BRANDING_DESCRIPTION_MAX = 160;

export const BRANDING_DEFAULTS: Record<BrandingTarget, { title: string; description: string | null }> = {
  admin: { title: "ONQ 마스터 관리자", description: null },
  seller: { title: "ONQ 파트너스 관리자", description: "쇼핑몰 운영과 방송 주문대기를 한곳에서 관리합니다." },
};

export const BRANDING_MESSAGES = {
  invalid_branding_text: `제목은 ${BRANDING_TITLE_MAX}자, 설명은 ${BRANDING_DESCRIPTION_MAX}자까지 입력할 수 있습니다.`,
  empty_file: "파일을 선택해 주십시오.",
} as const;

const IMAGE_MESSAGES: Record<ImageSlot, Record<ImageRejection, string>> = {
  favicon: {
    file_too_large: "파비콘이 256KB를 넘습니다. 256KB 이하 PNG로 줄여 주십시오.",
    unsupported_image: "파비콘은 PNG 파일만 업로드할 수 있습니다.",
    wrong_image_size: "파비콘 PNG는 한 변이 16~1024px이어야 합니다.",
  },
  ogImage: {
    file_too_large: "공유 카드 이미지가 2MB를 넘습니다. 2MB 이하 PNG로 줄여 주십시오.",
    unsupported_image: "공유 카드 이미지는 PNG 파일만 업로드할 수 있습니다.",
    wrong_image_size: "공유 카드 이미지는 1200×630 크기여야 합니다.",
  },
};

export const imageMessage = (slot: ImageSlot, reason: ImageRejection | "empty_file") =>
  reason === "empty_file" ? BRANDING_MESSAGES.empty_file : IMAGE_MESSAGES[slot][reason];

type Meta = { ip?: string | null; userAgent?: string | null };

// 올린 파비콘이 없을 때 쓰는 기본 ONQ 아이콘(public/branding, 로고 심볼 .logo-sym과 같은 모양·색). 32px 탭 아이콘과 180px 홈 화면 아이콘.
export const DEFAULT_FAVICON = { url: "/branding/onq-32.png", appleUrl: "/branding/onq-180.png", type: "image/png" } as const;
// 마스터 관리자 기본 아이콘: 같은 모양을 마스터 식별색 틸(--master #0f766e)로 그린 것. 탭이 여러 개 열려 있어도 구분된다(대표님 지시 2026-10-04).
export const DEFAULT_ADMIN_FAVICON = { url: "/branding/onq-admin-32.png", appleUrl: "/branding/onq-admin-180.png", type: "image/png" } as const;
// 올린 파비콘이 없을 때 쓰는 기본 아이콘(대상별)
export const defaultFavicon = (target: BrandingTarget) => (target === "admin" ? DEFAULT_ADMIN_FAVICON : DEFAULT_FAVICON);

// 주소: 파비콘 /api/branding/{target}/favicon?v=해시, 공유 카드 /api/branding/{target}/og?v=버전
export const faviconUrl = (target: BrandingTarget, hash: string) => `/api/branding/${target}/favicon?v=${hash}`;
export const ogImageUrl = (target: BrandingTarget, version: string) => `/api/branding/${target}/og?v=${version}`;

// 서버가 그린 카드의 버전: 그림이 바뀌는 값(제목)의 해시
export const generatedCardVersion = (title: string) => createHash("sha256").update(`brand-card-v1\0${title}`).digest("hex").slice(0, 12);

export type BrandingView = {
  target: BrandingTarget;
  title: string | null;
  description: string | null;
  defaults: { title: string; description: string | null };
  favicon: { url: string; type: string } | null;
  // 올린 파비콘이 없을 때 쓰는 기본 아이콘 주소(설정 화면 미리보기용)
  defaultFaviconUrl: string;
  ogImage: { url: string; uploaded: boolean; width: 1200; height: 630 };
  updatedAt: string | null;
};

async function view(db: PrismaClient, target: BrandingTarget): Promise<BrandingView> {
  const row = await db.siteBranding.findUnique({
    where: { target },
    select: { ogTitle: true, ogDescription: true, faviconType: true, faviconHash: true, ogImageHash: true, updatedAt: true },
  });
  const cardTitle = row?.ogTitle ?? BRANDING_DEFAULTS[target].title;
  return {
    target,
    title: row?.ogTitle ?? null,
    description: row?.ogDescription ?? null,
    defaults: BRANDING_DEFAULTS[target],
    favicon: row?.faviconHash && row.faviconType ? { url: faviconUrl(target, row.faviconHash), type: row.faviconType } : null,
    defaultFaviconUrl: defaultFavicon(target).url,
    ogImage: {
      url: ogImageUrl(target, row?.ogImageHash ?? generatedCardVersion(cardTitle)),
      uploaded: !!row?.ogImageHash,
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
    },
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

// 설정 화면용: 두 대상의 현재 값과 이 관리자가 바꿀 수 있는지. 호출 전에 platform.read 확인(라우트).
export async function readBrandingSettings(db: PrismaClient, admin: AdminSessionContext) {
  return { canEdit: adminCan(admin.admin.role, "system.manage"), targets: await Promise.all((["admin", "seller"] as const).map((t) => view(db, t))) };
}

function requireEditor(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
}

// null·빈 문자열 → null(기본값으로), 글자 → 정리한 값, 그 밖(형식·길이·보이지 않는 문자) → undefined(거부)
function field(v: unknown, max: number, kind: "name" | "memo"): string | null | undefined {
  if (v === null || v === "") return null;
  return cleanText(v, max, kind) ?? undefined;
}

// 본문: { title: string | null, description: string | null }
export async function updateBrandingText(db: PrismaClient, admin: AdminSessionContext, target: BrandingTarget, raw: unknown, meta: Meta = {}) {
  requireEditor(admin);
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const title = field(b.title, BRANDING_TITLE_MAX, "name");
  const description = field(b.description, BRANDING_DESCRIPTION_MAX, "memo");
  if (title === undefined || description === undefined) return { ok: false as const, reason: "invalid_branding_text" as const };
  await db.$transaction(async (tx) => {
    const before = await tx.siteBranding.findUnique({ where: { target }, select: { ogTitle: true, ogDescription: true } });
    await tx.siteBranding.upsert({ where: { target }, create: { target, ogTitle: title, ogDescription: description }, update: { ogTitle: title, ogDescription: description } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "branding.text.update",
      targetType: "SiteBranding",
      targetId: target,
      before: { title: before?.ogTitle ?? null, description: before?.ogDescription ?? null },
      after: { title, description },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, branding: await view(db, target) };
}

// 이미지 올리기(파비콘·공유 카드). 형식·크기 확인 뒤 저장. 감사 로그에는 바이트 대신 형식·크기·해시만 남긴다.
export async function setBrandingImage(db: PrismaClient, admin: AdminSessionContext, target: BrandingTarget, slot: ImageSlot, data: Buffer, meta: Meta = {}) {
  requireEditor(admin);
  const check = slot === "favicon" ? checkFavicon(data) : checkOgImage(data);
  if (!check.ok) return { ok: false as const, reason: check.reason, message: imageMessage(slot, check.reason) };
  const image = { data, type: check.info.type, hash: imageHash(data) };
  await db.$transaction(async (tx) => {
    const before = await readImage(tx, target, slot);
    await writeImage(tx, target, slot, image);
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: `branding.${slot === "favicon" ? "favicon" : "og_image"}.update`,
      targetType: "SiteBranding",
      targetId: target,
      before: before && { type: before.type, bytes: before.data.length, hash: before.hash },
      after: { type: image.type, bytes: data.length, hash: image.hash, width: check.info.width, height: check.info.height },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, branding: await view(db, target) };
}

// 기본값으로 되돌리기(올린 이미지 지움). 지울 것이 없어도 성공으로 본다(감사 로그는 실제로 지웠을 때만).
export async function resetBrandingImage(db: PrismaClient, admin: AdminSessionContext, target: BrandingTarget, slot: ImageSlot, meta: Meta = {}) {
  requireEditor(admin);
  await db.$transaction(async (tx) => {
    const before = await readImage(tx, target, slot);
    if (!before) return;
    await removeImage(tx, target, slot);
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: `branding.${slot === "favicon" ? "favicon" : "og_image"}.reset`,
      targetType: "SiteBranding",
      targetId: target,
      before: { type: before.type, bytes: before.data.length, hash: before.hash },
      after: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, branding: await view(db, target) };
}

// 관리자 화면 head에 넣을 값(layout의 generateMetadata). 로그인 없이 읽는 값만 담는다.
export type BrandingMeta = {
  title: string;
  description: string | null;
  favicon: { url: string; type: string } | null;
  image: { url: string; width: 1200; height: 630 };
};

export async function brandingMeta(db: PrismaClient, target: BrandingTarget): Promise<BrandingMeta> {
  const v = await view(db, target);
  return {
    title: v.title ?? v.defaults.title,
    description: v.description ?? v.defaults.description,
    favicon: v.favicon,
    image: { url: v.ogImage.url, width: v.ogImage.width, height: v.ogImage.height },
  };
}

// 공개 이미지 응답에 쓰는 값: 올린 공유 카드 이미지, 없으면 그릴 카드 제목과 버전
export async function ogImageSource(db: PrismaClient, target: BrandingTarget) {
  const uploaded = await readImage(db, target, "ogImage");
  if (uploaded) return { kind: "uploaded" as const, image: uploaded };
  const row = await db.siteBranding.findUnique({ where: { target }, select: { ogTitle: true } });
  const title = row?.ogTitle ?? BRANDING_DEFAULTS[target].title;
  return { kind: "generated" as const, title, version: generatedCardVersion(title) };
}
