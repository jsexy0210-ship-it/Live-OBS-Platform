import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

// 브랜딩 이미지 저장소. 지금은 Postgres bytea(SiteBranding 표)에 둔다(대표님 저장소 결정 A/B 전, 비용 없음).
// 버킷(B)으로 바꿀 때는 이 파일의 세 함수만 바꾼다(호출하는 쪽은 바이트·형식·해시만 주고받는다).

type Db = PrismaClient | Prisma.TransactionClient;

export const BRANDING_TARGETS = ["admin", "seller"] as const;
export type BrandingTarget = (typeof BRANDING_TARGETS)[number];
export const isBrandingTarget = (v: unknown): v is BrandingTarget => typeof v === "string" && (BRANDING_TARGETS as readonly string[]).includes(v);

export type ImageSlot = "favicon" | "ogImage";
export type StoredImage = { data: Buffer; type: string; hash: string };

// 주소 버전 값: 바이트의 sha256 앞 12자
export const imageHash = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 12);

const COLUMNS = {
  favicon: { data: "faviconData", type: "faviconType", hash: "faviconHash" },
  ogImage: { data: "ogImageData", type: "ogImageType", hash: "ogImageHash" },
} as const;

export async function readImage(db: Db, target: BrandingTarget, slot: ImageSlot): Promise<StoredImage | null> {
  const c = COLUMNS[slot];
  const row = (await db.siteBranding.findUnique({ where: { target }, select: { [c.data]: true, [c.type]: true, [c.hash]: true } })) as Record<string, unknown> | null;
  const data = row?.[c.data];
  if (!row || !data) return null;
  return { data: Buffer.from(data as Uint8Array), type: row[c.type] as string, hash: row[c.hash] as string };
}

export async function writeImage(db: Db, target: BrandingTarget, slot: ImageSlot, image: StoredImage): Promise<void> {
  const c = COLUMNS[slot];
  const data = { [c.data]: image.data, [c.type]: image.type, [c.hash]: image.hash };
  await db.siteBranding.upsert({ where: { target }, create: { target, ...data }, update: data });
}

export async function removeImage(db: Db, target: BrandingTarget, slot: ImageSlot): Promise<void> {
  const c = COLUMNS[slot];
  await db.siteBranding.updateMany({ where: { target }, data: { [c.data]: null, [c.type]: null, [c.hash]: null } });
}
