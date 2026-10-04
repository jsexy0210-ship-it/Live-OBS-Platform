import { crc32, inflateSync } from "node:zlib";

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

// PNG: 구조와 내용을 모두 확인한다(머리만 맞춘 파일·빈 그림 데이터를 받지 않게).
// - 구조: 첫 청크 IHDR(길이 13), 청크마다 범위·CRC, PLTE 규칙, IDAT는 이어져 있고 1개 이상, 길이 0인 IEND로 파일이 끝남
// - IHDR: 색 형식·비트 깊이 조합, 압축·필터 방식 0, 인터레이스 0(없음)·1(Adam7)
// - 내용: IDAT를 모두 이어 zlib으로 풀어(크기 상한을 둬 압축 폭탄을 막음) 풀린 길이가 IHDR로 계산한 길이와 같고,
//   줄마다 앞의 필터 바이트가 0~4여야 한다.
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Adam7 단계별 [시작 x, 시작 y, x 간격, y 간격]
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
// 풀린 그림 데이터 상한(파비콘 1024×1024·카드 1200×630의 가장 큰 형식보다 넉넉함)
const PNG_MAX_RAW = 16 * 1024 * 1024;

// 풀린 데이터의 줄 목록: [줄 수, 줄 바이트 수(필터 바이트 제외)]
function pngRows(width: number, height: number, bits: number, interlace: number): [number, number][] {
  const rowBytes = (w: number) => Math.ceil((w * bits) / 8);
  if (interlace === 0) return [[height, rowBytes(width)]];
  return ADAM7.map(([x0, y0, dx, dy]) => {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    return [w === 0 ? 0 : h, rowBytes(w)] as [number, number];
  });
}

function png(b: Buffer, verify = true): ImageInfo | null {
  if (b.length < 45 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const [depth, color, compression, filter, interlace] = [b[24], b[25], b[26], b[27], b[28]];
  if (width === 0 || height === 0 || !PNG_DEPTHS[color]?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) return null;
  const rows = pngRows(width, height, PNG_CHANNELS[color] * depth, interlace);
  const expected = rows.reduce((n, [h, w]) => n + h * (1 + w), 0);
  if (expected === 0 || (verify && expected > PNG_MAX_RAW)) return null;

  const idat: Buffer[] = [];
  let idatClosed = false;
  let plte = false;
  let o = 8;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    const end = o + 12 + len;
    if (end > b.length) return null;
    const type = b.toString("latin1", o + 4, o + 8);
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== b.readUInt32BE(o + 8 + len)) return null;
    if (type === "IHDR" && o !== 8) return null;
    if (type === "PLTE") {
      // 회색조에는 없어야 하고, 그림 데이터 앞에 한 번, 항목 수는 1~256(색 번호 형식은 비트 깊이 안)
      const entries = len / 3;
      if (plte || idat.length > 0 || color === 0 || color === 4 || len % 3 !== 0 || entries < 1 || entries > (color === 3 ? 2 ** depth : 256)) return null;
      plte = true;
    }
    if (type === "IDAT") {
      if (idatClosed) return null;
      idat.push(b.subarray(o + 8, o + 8 + len));
    } else if (idat.length > 0) idatClosed = true;
    if (type === "IEND") {
      if (len !== 0 || end !== b.length || idat.length === 0 || (color === 3 && !plte)) return null;
      return !verify || pngPixelsOk(Buffer.concat(idat), rows, expected) ? { type: "image/png", width, height } : null;
    }
    o = end;
  }
  return null;
}

function pngPixelsOk(compressed: Buffer, rows: [number, number][], expected: number): boolean {
  let raw: Buffer;
  try {
    raw = inflateSync(compressed, { maxOutputLength: expected + 1 });
  } catch {
    return false;
  }
  if (raw.length !== expected) return false;
  let o = 0;
  for (const [h, w] of rows) {
    for (let y = 0; y < h; y++) {
      if (raw[o] > 4) return false;
      o += 1 + w;
    }
  }
  return true;
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

// JPEG: SOI(FFD8) 뒤 표식을 따라가며 확인한다(머리만 맞춘 파일·빈 그림 데이터를 받지 않게).
// - 프레임 시작(SOF0~SOF15, DHT·JPG·DAC 제외) 1개: 정밀도 8·12, 구성 요소 1·3·4개, 길이 = 8 + 3×개수,
//   요소마다 가로·세로 표본 비율 1~4, 양자화표 번호 0~3. 크기는 여기서 읽는다.
// - 첫 스캔 시작(SOS): SOF 뒤, 요소 1~4개, 길이 = 6 + 2×개수, 바로 뒤에 그림(엔트로피) 데이터가 1바이트 이상
// - 파일은 EOI(FFD9)로 끝나야 한다.
function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  let o = 2;
  let frame: { width: number; height: number; components: number } | null = null;
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
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (frame || len < 8) return null;
      const precision = b[o + 4];
      const height = b.readUInt16BE(o + 5);
      const width = b.readUInt16BE(o + 7);
      const components = b[o + 9];
      if ((precision !== 8 && precision !== 12) || width === 0 || height === 0 || ![1, 3, 4].includes(components) || len !== 8 + 3 * components) return null;
      for (let i = 0; i < components; i++) {
        const sampling = b[o + 11 + i * 3];
        const [hs, vs] = [sampling >> 4, sampling & 0x0f];
        if (hs < 1 || hs > 4 || vs < 1 || vs > 4 || b[o + 12 + i * 3] > 3) return null;
      }
      frame = { width, height, components };
    }
    if (marker === 0xda) {
      const n = b[o + 4];
      if (!frame || n < 1 || n > 4 || n > frame.components || len !== 6 + 2 * n) return null;
      return jpegHasScanData(b, o + 2 + len) ? { type: "image/jpeg", width: frame.width, height: frame.height } : null;
    }
    o += 2 + len;
  }
  return null;
}

// 스캔 머리 뒤에서 다음 표식(채움 FF00·RSTn 제외)까지 그림 데이터가 1바이트 이상인지
function jpegHasScanData(b: Buffer, start: number): boolean {
  let n = 0;
  for (let i = start; i < b.length - 1; i++) {
    if (b[i] === 0xff) {
      const next = b[i + 1];
      if (next === 0x00) {
        n++;
        i++;
        continue;
      }
      if (next >= 0xd0 && next <= 0xd7) {
        i++;
        continue;
      }
      if (next === 0xff) continue;
      return n > 0;
    }
    n++;
  }
  return false;
}

export function detectImage(b: Buffer): ImageInfo | null {
  return png(b) ?? ico(b) ?? jpeg(b);
}

// 형식·크기만 먼저 읽는다(PNG 그림 데이터는 풀지 않음). 크기가 틀린 파일은 풀기 전에 「크기」로 안내하려고 쓴다.
const sniff = (b: Buffer): ImageInfo | null => png(b, false) ?? ico(b) ?? jpeg(b);

export type ImageRejection = "file_too_large" | "unsupported_image" | "wrong_image_size";

export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; reason: ImageRejection | "empty_file" };

// 파비콘: PNG·ICO만, 256KB까지. PNG는 한 변 16~1024px(정사각형 권장은 화면에서 안내).
export function checkFavicon(b: Buffer): ImageCheck {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > FAVICON_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const info = sniff(b);
  if (!info || (info.type !== "image/png" && info.type !== "image/x-icon")) return { ok: false, reason: "unsupported_image" };
  const side = (n: number) => n >= FAVICON_MIN_SIDE && n <= FAVICON_MAX_SIDE;
  if (info.type === "image/png" && !(side(info.width) && side(info.height))) return { ok: false, reason: "wrong_image_size" };
  return detectImage(b) ? { ok: true, info } : { ok: false, reason: "unsupported_image" };
}

// 공유 카드 이미지: PNG·JPEG만, 2MB까지, 1200×630 그대로.
export function checkOgImage(b: Buffer): ImageCheck {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > OG_IMAGE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const info = sniff(b);
  if (!info || (info.type !== "image/png" && info.type !== "image/jpeg")) return { ok: false, reason: "unsupported_image" };
  if (info.width !== OG_IMAGE_WIDTH || info.height !== OG_IMAGE_HEIGHT) return { ok: false, reason: "wrong_image_size" };
  return detectImage(b) ? { ok: true, info } : { ok: false, reason: "unsupported_image" };
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
