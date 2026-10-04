import { crc32 } from "node:zlib";

// 올린 이미지의 형식 확인. 파일 이름·Content-Type은 믿지 않고 파일 앞부분 바이트(시그니처)와 헤더 구조로 판단한다.
// SVG는 스크립트를 품을 수 있어 받지 않는다(텍스트 파일은 어떤 시그니처에도 맞지 않아 거부된다).

export const FAVICON_MAX_BYTES = 256 * 1024;
export const OG_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
// 파비콘 PNG 한 변 길이(정사각형 권장, 강제하지 않음)
const FAVICON_MIN_SIDE = 16;
const FAVICON_MAX_SIDE = 1024;

export type ImageType = "image/png" | "image/x-icon" | "image/jpeg";
export type ImageInfo = { type: ImageType; width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG: 시그니처 + 첫 청크 IHDR(길이 13). 머리만 맞춘 잘린 파일을 막으려고 청크를 끝까지 따라가며
// 각 청크의 범위와 CRC를 확인하고, IDAT가 1개 이상 있고 IEND로 끝나야 받는다. 크기는 IHDR에서 읽는다.
function png(b: Buffer): ImageInfo | null {
  if (b.length < 45 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  let o = 8;
  let idat = false;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    const end = o + 12 + len;
    if (end > b.length) return null;
    const type = b.toString("latin1", o + 4, o + 8);
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== b.readUInt32BE(o + 8 + len)) return null;
    if (type === "IDAT") idat = true;
    if (type === "IEND") return idat && len === 0 && end === b.length ? { type: "image/png", width, height } : null;
    o = end;
  }
  return null;
}

// ICO: 예약 0 + 형식 1(아이콘) + 이미지 수 1개 이상. 각 이미지 항목이 가리키는 범위가 파일 안에 있고,
// 그 안의 데이터가 온전한 PNG이거나 BMP 정보 머리(40바이트, 크기·색 깊이가 맞음)여야 한다. 크기는 가장 큰 항목(0은 256)을 쓴다.
function ico(b: Buffer): ImageInfo | null {
  if (b.length < 22 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const count = b.readUInt16LE(4);
  if (count === 0 || 6 + count * 16 > b.length) return null;
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const size = b.readUInt32LE(o + 8);
    const offset = b.readUInt32LE(o + 12);
    if (b[o + 3] !== 0 || size === 0 || offset < 6 + count * 16 || offset + size > b.length) return null;
    const w = b[o] || 256;
    const h = b[o + 1] || 256;
    const data = b.subarray(offset, offset + size);
    if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      if (!png(data)) return null;
    } else if (!bmpIcon(data, w, h)) return null;
    width = Math.max(width, w);
    height = Math.max(height, h);
  }
  return { type: "image/x-icon", width, height };
}

// ICO 안의 BMP: BITMAPINFOHEADER(40바이트), 가로 = 항목 가로, 세로 = 항목 세로 × 2(색 + 투명 마스크), 면 1,
// 색 깊이 1·4·8·24·32, 압축 없음. 색 데이터와 마스크가 크기 안에 다 들어 있어야 한다.
function bmpIcon(d: Buffer, w: number, h: number): boolean {
  if (d.length < 40 || d.readUInt32LE(0) !== 40) return false;
  if (d.readInt32LE(4) !== w || d.readInt32LE(8) !== h * 2 || d.readUInt16LE(12) !== 1) return false;
  const bpp = d.readUInt16LE(14);
  if (![1, 4, 8, 24, 32].includes(bpp) || d.readUInt32LE(16) !== 0) return false;
  const palette = bpp <= 8 ? (d.readUInt32LE(32) || 2 ** bpp) * 4 : 0;
  const row = (bits: number) => Math.ceil((w * bits) / 32) * 4;
  return d.length >= 40 + palette + row(bpp) * h + row(1) * h;
}

// JPEG: SOI(FFD8) 뒤 표식을 따라가 프레임 시작(SOF0~SOF15, DHT·JPG·DAC 제외)에서 크기를 읽는다.
// 머리만 맞춘 잘린 파일을 막으려고 SOF 뒤 스캔 시작(SOS)이 있고 파일이 EOI(FFD9)로 끝나야 받는다.
function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let o = 2;
  let size: { width: number; height: number } | null = null;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    // 길이 없는 표식(RSTn·TEM)
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const len = b.readUInt16BE(o + 2);
    if (len < 2 || o + 2 + len > b.length) return null;
    if (marker === 0xda) return size ? { type: "image/jpeg", ...size } : null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7 || size) return null;
      const height = b.readUInt16BE(o + 5);
      const width = b.readUInt16BE(o + 7);
      if (width === 0 || height === 0) return null;
      size = { width, height };
    }
    o += 2 + len;
  }
  return null;
}

export function detectImage(b: Buffer): ImageInfo | null {
  return png(b) ?? ico(b) ?? jpeg(b);
}

export type ImageRejection = "file_too_large" | "unsupported_image" | "wrong_image_size";

export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; reason: ImageRejection | "empty_file" };

// 파비콘: PNG·ICO만, 256KB까지. PNG는 한 변 16~1024px(정사각형 권장은 화면에서 안내).
export function checkFavicon(b: Buffer): ImageCheck {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > FAVICON_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const info = detectImage(b);
  if (!info || (info.type !== "image/png" && info.type !== "image/x-icon")) return { ok: false, reason: "unsupported_image" };
  const side = (n: number) => n >= FAVICON_MIN_SIDE && n <= FAVICON_MAX_SIDE;
  if (info.type === "image/png" && !(side(info.width) && side(info.height))) return { ok: false, reason: "wrong_image_size" };
  return { ok: true, info };
}

// 공유 카드 이미지: PNG·JPEG만, 2MB까지, 1200×630 그대로.
export function checkOgImage(b: Buffer): ImageCheck {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > OG_IMAGE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const info = detectImage(b);
  if (!info || (info.type !== "image/png" && info.type !== "image/jpeg")) return { ok: false, reason: "unsupported_image" };
  if (info.width !== OG_IMAGE_WIDTH || info.height !== OG_IMAGE_HEIGHT) return { ok: false, reason: "wrong_image_size" };
  return { ok: true, info };
}

// 요청 본문을 max 바이트까지만 읽는다. 넘으면 null(끝까지 받지 않고 끊는다).
export async function readBodyLimited(req: Request, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
