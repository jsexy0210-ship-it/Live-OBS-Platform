import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

// 파트너스 가입 신청 사업자등록증 파일(PF-007-4). JPG·PNG·PDF, 10MB 이하. 파일 이름·Content-Type은 믿지 않고 앞부분 바이트로 형식을 판단한다.
// 비용 없는 DB 저장(파비콘과 같은 방식). 신청 전에는 본인확인 기록(verificationId)의 임시 파일, 신청을 만들 때 쇼핑몰(sellerId)로 옮긴다.
export const LICENSE_MAX_BYTES = 10 * 1024 * 1024;
export type LicenseType = "image/jpeg" | "image/png" | "application/pdf";
const EXT: Record<LicenseType, string> = { "image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf" };

export type LicenseFailure = "file_empty" | "file_too_large" | "file_type_invalid";
export const LICENSE_MESSAGES: Record<LicenseFailure, string> = {
  file_empty: "파일이 비어 있어요. 다른 파일을 올려 주세요",
  file_too_large: "10MB 이하 파일만 올릴 수 있어요",
  file_type_invalid: "JPG · PNG · PDF 파일만 올릴 수 있어요",
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

// 시그니처와 끝 표시를 모두 확인한다(머리만 맞춘 잘린 파일을 받지 않게). 그림 데이터까지 풀어 보지는 않는다 —
// 파일은 마스터가 내려받아 보는 용도이고, 응답은 항상 nosniff·내려받기·sandbox로 보내 브라우저가 실행하지 못한다.
export function detectLicenseType(b: Buffer): LicenseType | null {
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) return "image/jpeg";
  if (b.length > PNG_SIG.length + PNG_IEND.length && b.subarray(0, 8).equals(PNG_SIG) && b.subarray(b.length - 8).equals(PNG_IEND)) return "image/png";
  if (b.subarray(0, 5).toString("latin1") === "%PDF-" && b.subarray(Math.max(0, b.length - 1024)).toString("latin1").includes("%%EOF")) return "application/pdf";
  return null;
}

// 화면에 보이는 파일 이름: 경로·제어 문자를 지우고 100자로 줄이며 확장자는 실제 형식에 맞춘다
export function cleanLicenseName(raw: string | null | undefined, type: LicenseType): string {
  const base = (raw ?? "").replace(/^.*[\\/]/, "").replace(/[\p{C}"<>:*?|]/gu, "").trim().replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 90).trim();
  return `${base || "사업자등록증"}${EXT[type]}`;
}

export type LicenseSummary = { fileName: string; mimeType: string; byteSize: number; uploadedAt: string };
const summary = (r: { fileName: string; mimeType: string; byteSize: number; uploadedAt: Date }): LicenseSummary => ({
  fileName: r.fileName,
  mimeType: r.mimeType,
  byteSize: r.byteSize,
  uploadedAt: r.uploadedAt.toISOString(),
});

export function checkLicenseFile(bytes: Buffer): { ok: true; type: LicenseType } | { ok: false; reason: LicenseFailure } {
  if (bytes.length === 0) return { ok: false, reason: "file_empty" };
  if (bytes.length > LICENSE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const type = detectLicenseType(bytes);
  return type ? { ok: true, type } : { ok: false, reason: "file_type_invalid" };
}

// 신청 전(본인확인 기록에 묶음): 다시 올리면 바꾼다
export async function putDraftLicense(db: PrismaClient, verificationId: string, bytes: Buffer, rawName: string | null, now = new Date()) {
  const f = checkLicenseFile(bytes);
  if (!f.ok) return f;
  const data = { fileName: cleanLicenseName(rawName, f.type), mimeType: f.type, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data: new Uint8Array(bytes), uploadedAt: now };
  const row = await db.sellerBusinessLicense.upsert({ where: { verificationId }, create: { verificationId, ...data }, update: data });
  return { ok: true as const, license: summary(row) };
}

export async function readDraftLicense(db: PrismaClient, verificationId: string) {
  const row = await db.sellerBusinessLicense.findUnique({ where: { verificationId }, select: { fileName: true, mimeType: true, byteSize: true, uploadedAt: true } });
  return row ? summary(row) : null;
}

export async function deleteDraftLicense(db: PrismaClient, verificationId: string) {
  await db.sellerBusinessLicense.deleteMany({ where: { verificationId, sellerId: null } });
}

// 신청을 만드는 트랜잭션 안에서: 임시 파일을 쇼핑몰로 옮긴다. 옮긴 파일의 요약(없으면 null)
export async function attachDraftLicense(tx: Prisma.TransactionClient, verificationId: string, sellerId: string): Promise<LicenseSummary | null> {
  const moved = await tx.sellerBusinessLicense.updateMany({ where: { verificationId, sellerId: null }, data: { sellerId, verificationId: null } });
  if (moved.count !== 1) return null;
  const row = await tx.sellerBusinessLicense.findUniqueOrThrow({ where: { sellerId }, select: { fileName: true, mimeType: true, byteSize: true, uploadedAt: true } });
  return summary(row);
}

export async function licenseSummaryOf(db: PrismaClient, sellerId: string): Promise<LicenseSummary | null> {
  const row = await db.sellerBusinessLicense.findUnique({ where: { sellerId }, select: { fileName: true, mimeType: true, byteSize: true, uploadedAt: true } });
  return row ? summary(row) : null;
}
