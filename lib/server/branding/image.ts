import { crc32, inflateSync } from "node:zlib";

// 올린 이미지의 형식 확인. 파일 이름·Content-Type은 믿지 않고 파일 앞부분 바이트(시그니처)와 헤더 구조로 판단한다.
// 받는 형식은 PNG뿐이다(파비콘·공유 카드 모두, MASTER 결정 2026-10-04: 다른 형식은 그림 데이터까지 확인하기 어려움). SVG는 스크립트를 품을 수 있어 받지 않는다(텍스트 파일은 어떤 시그니처에도 맞지 않아 거부된다).

export const FAVICON_MAX_BYTES = 256 * 1024;
export const OG_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
// 파비콘 PNG 한 변 길이(정사각형 권장, 강제하지 않음)
const FAVICON_MIN_SIDE = 16;
const FAVICON_MAX_SIDE = 1024;

export type ImageType = "image/png";
export type ImageInfo = { type: ImageType; width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG: 구조와 내용을 모두 확인한다(머리만 맞춘 파일·빈 그림 데이터를 받지 않게).
// - 구조: 첫 청크 IHDR(길이 13), 청크마다 범위·CRC, PLTE 규칙, IDAT는 이어져 있고 1개 이상, 길이 0인 IEND로 파일이 끝남
// - IHDR: 색 형식·비트 깊이 조합, 압축·필터 방식 0, 인터레이스 0(없음)·1(Adam7)
// - 내용: IDAT를 모두 이어 zlib으로 풀어(크기 상한을 둬 압축 폭탄을 막음) 풀린 길이가 IHDR로 계산한 길이와 같고,
//   줄마다 앞의 필터 바이트가 0~4여야 한다. 필터를 되돌려 표본 값을 복원하고 색 번호는 PLTE 항목 수 안이어야 한다.
// - tRNS: 그림 데이터 앞 한 번, 형식별 길이 규칙
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
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
// 파일 하나에서 풀어 볼 그림 데이터 상한(= 필터 되돌리기 작업량 상한). 받는 가장 큰 경우인 파비콘 1024×1024 RGBA 16비트
// (1024 × (1 + 1024 × 8) = 8,389,632바이트)를 겨우 넘는 값이다. IHDR로 계산한 길이가 이보다 크면 풀지 않고 거부한다.
const PNG_MAX_RAW = 8_400_000;

// 풀린 데이터의 단계(인터레이스가 없으면 1개) 목록: [줄 수, 줄 바이트 수(필터 바이트 제외), 줄의 화소 수]
type PngPass = [rows: number, rowBytes: number, pixels: number];
function pngRows(width: number, height: number, bits: number, interlace: number): PngPass[] {
  const rowBytes = (w: number) => Math.ceil((w * bits) / 8);
  if (interlace === 0) return [[height, rowBytes(width), width]];
  return ADAM7.map(([x0, y0, dx, dy]) => {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    return [w === 0 ? 0 : h, rowBytes(w), w] as PngPass;
  });
}

function png(b: Buffer): ImageInfo | null {
  if (b.length < 45 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const [depth, color, compression, filter, interlace] = [b[24], b[25], b[26], b[27], b[28]];
  if (width === 0 || height === 0 || !PNG_DEPTHS[color]?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) return null;
  const rows = pngRows(width, height, PNG_CHANNELS[color] * depth, interlace);
  const expected = rows.reduce((n, [h, w]) => n + h * (1 + w), 0);
  if (expected === 0 || expected > PNG_MAX_RAW) return null;

  const idat: Buffer[] = [];
  let idatClosed = false;
  let plteEntries = 0;
  let trns = false;
  let o = 8;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    const end = o + 12 + len;
    if (end > b.length) return null;
    const type = b.toString("latin1", o + 4, o + 8);
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== b.readUInt32BE(o + 8 + len)) return null;
    if (type === "IHDR" && o !== 8) return null;
    // 조각 이름 규칙: 영문자만, 셋째 글자(예약 비트)는 대문자. 첫 글자가 대문자인 필수 조각은 아는 것(IHDR·PLTE·IDAT·IEND)만 받는다
    // (모르는 필수 조각이 있으면 디코더는 그림을 버린다). 소문자로 시작하는 보조 조각은 건너뛴다.
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || (/^[A-Z]/.test(type) && !PNG_CRITICAL.has(type))) return null;
    if (type === "PLTE") {
      // 회색조에는 없어야 하고, 그림 데이터 앞에 한 번, 항목 수는 1~256(색 번호 형식은 비트 깊이 안)
      const entries = len / 3;
      if (plteEntries || trns || idat.length > 0 || color === 0 || color === 4 || len % 3 !== 0 || entries < 1 || entries > (color === 3 ? 2 ** depth : 256)) return null;
      plteEntries = entries;
    }
    if (type === "tRNS") {
      // 투명도: 그림 데이터 앞에 한 번. 색 번호 형식은 PLTE 뒤·항목 수 이하, 회색조는 2바이트, RGB는 6바이트, 알파가 있는 형식에는 없어야 한다
      const ok = color === 3 ? plteEntries > 0 && len >= 1 && len <= plteEntries : color === 0 ? len === 2 : color === 2 ? len === 6 : false;
      if (trns || idat.length > 0 || !ok) return null;
      trns = true;
    }
    if (type === "IDAT") {
      if (idatClosed) return null;
      idat.push(b.subarray(o + 8, o + 8 + len));
    } else if (idat.length > 0) idatClosed = true;
    if (type === "IEND") {
      if (len !== 0 || end !== b.length || idat.length === 0 || (color === 3 && !plteEntries)) return null;
      const pixels = { bytesPerPixel: Math.ceil((PNG_CHANNELS[color] * depth) / 8), depth, paletteEntries: color === 3 ? plteEntries : 0 };
      return pngPixelsOk(Buffer.concat(idat), rows, expected, pixels) ? { type: "image/png", width, height } : null;
    }
    o = end;
  }
  return null;
}

// 풀린 데이터를 PNG 규격대로 줄마다 필터(None·Sub·Up·Average·Paeth, Adam7은 단계별)를 되돌려 실제 표본 값으로 복원한다.
// 색 번호 형식은 모든 화소의 색 번호가 PLTE 항목 수보다 작아야 한다(밖이면 디코더가 그림을 버림).
function pngPixelsOk(
  compressed: Buffer,
  passes: PngPass[],
  expected: number,
  px: { bytesPerPixel: number; depth: number; paletteEntries: number },
): boolean {
  let raw: Buffer;
  try {
    raw = inflateSync(compressed, { maxOutputLength: expected + 1 });
  } catch {
    return false;
  }
  if (raw.length !== expected) return false;
  const bpp = px.bytesPerPixel;
  let o = 0;
  for (const [h, rowBytes, pixels] of passes) {
    let prev = Buffer.alloc(rowBytes);
    for (let y = 0; y < h; y++) {
      const f = raw[o];
      if (f > 4) return false;
      const cur = Buffer.from(raw.subarray(o + 1, o + 1 + rowBytes));
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = prev[i];
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        if (f === 1) cur[i] = (cur[i] + left) & 0xff;
        else if (f === 2) cur[i] = (cur[i] + up) & 0xff;
        else if (f === 3) cur[i] = (cur[i] + ((left + up) >> 1)) & 0xff;
        else if (f === 4) {
          const p = left + up - upLeft;
          const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
        }
      }
      if (px.paletteEntries) {
        const d = px.depth;
        for (let x = 0; x < pixels; x++) {
          const index = d === 8 ? cur[x] : (cur[(x * d) >> 3] >> (8 - d - ((x * d) & 7))) & ((1 << d) - 1);
          if (index >= px.paletteEntries) return false;
        }
      }
      prev = cur;
      o += 1 + rowBytes;
    }
  }
  return true;
}

export function detectImage(b: Buffer): ImageInfo | null {
  return png(b);
}

// 시그니처와 IHDR(첫 33바이트)만 읽어 크기를 본다. 조각을 따라가거나 풀지 않는다(크기가 틀린 파일은 풀기 전에 「크기」로 안내).
function pngHeader(b: Buffer): ImageInfo | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// 머리로 크기를 먼저 본 뒤, 크기가 맞을 때만 한 번 끝까지 확인한다(풀기는 파일마다 한 번).
function checkPng(b: Buffer, sizeOk: (i: ImageInfo) => boolean): ImageCheck {
  const head = pngHeader(b);
  if (!head) return { ok: false, reason: "unsupported_image" };
  if (!sizeOk(head)) return { ok: false, reason: "wrong_image_size" };
  const info = png(b);
  return info ? { ok: true, info } : { ok: false, reason: "unsupported_image" };
}

export type ImageRejection = "file_too_large" | "unsupported_image" | "wrong_image_size";

export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; reason: ImageRejection | "empty_file" };

// 파비콘: PNG만, 256KB까지, 한 변 16~1024px(정사각형 권장은 화면에서 안내). ICO는 여러 장을 담아 풀기 비용이 커져 받지 않는다.
export function checkFavicon(b: Buffer): ImageCheck {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > FAVICON_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const side = (n: number) => n >= FAVICON_MIN_SIDE && n <= FAVICON_MAX_SIDE;
  return checkPng(b, (i) => side(i.width) && side(i.height));
}

// 공유 카드 이미지: PNG만, 2MB까지, 1200×630 그대로. JPEG는 그림 데이터까지 확인하려면 디코더가 필요해(새 의존성) 받지 않는다
// (MASTER 결정 2026-10-04, 형식을 좁혀도 된다).
export function checkOgImage(b: Buffer): ImageCheck {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > OG_IMAGE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  return checkPng(b, (i) => i.width === OG_IMAGE_WIDTH && i.height === OG_IMAGE_HEIGHT);
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
