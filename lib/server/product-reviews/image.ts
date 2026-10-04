import { checkPng } from "../shop-content/image";

// 리뷰 사진 검사(MASTER 2026-10-04): 화면이 canvas로 JPEG(긴 변 1600px, 품질 0.85)로 다시 저장해 올리고, 서버는 JPEG·PNG 바이트를 확인한다.
// - JPEG: 디코더 없이 마커 구조를 읽는다(SOI → 세그먼트 → SOFn에서 크기 → SOS 뒤 엔트로피 데이터 → EOI). 깨진 구조는 거부.
// - PNG: 쇼핑몰 공용 PNG 검사(checkPng, 그림 데이터까지)를 그대로 쓴다.
// - 위치 정보 등 메타데이터는 화면 재인코딩에서 빠지지만, 서버도 다시 지운다(JPEG APP1~APP15·COM, PNG 텍스트·eXIf·tIME 덩어리).
//   화면을 거치지 않은 요청이 와도 사진에 위치·기기 정보가 남지 않게 하기 위해서다.
export const REVIEW_IMAGE_MAX_BYTES = 1024 * 1024;
export const REVIEW_IMAGE_MAX_SIDE = 1600;
export const REVIEW_IMAGES_PER_REVIEW = 5;

export type ReviewImageRejection = "empty_file" | "file_too_large" | "unsupported_image" | "wrong_image_size" | "png_16bit" | "png_too_large";
export type ReviewImage = { type: "image/jpeg" | "image/png"; width: number; height: number; data: Buffer };

const sideOk = (w: number, h: number) => w >= 1 && h >= 1 && w <= REVIEW_IMAGE_MAX_SIDE && h <= REVIEW_IMAGE_MAX_SIDE;

export function checkReviewImage(b: Buffer): { ok: true; image: ReviewImage } | { ok: false; reason: ReviewImageRejection } {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > REVIEW_IMAGE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  if (b[0] === 0xff && b[1] === 0xd8) {
    const j = stripJpeg(b);
    if (!j) return { ok: false, reason: "unsupported_image" };
    if (!sideOk(j.width, j.height)) return { ok: false, reason: "wrong_image_size" };
    return { ok: true, image: { type: "image/jpeg", width: j.width, height: j.height, data: j.data } };
  }
  const r = checkPng(b, REVIEW_IMAGE_MAX_BYTES, (w, h) => (sideOk(w, h) ? null : ("wrong_image_size" as const)));
  if (!r.ok) return r;
  const data = stripPng(b);
  if (!data) return { ok: false, reason: "unsupported_image" };
  return { ok: true, image: { type: "image/png", width: r.width, height: r.height, data } };
}

// SOF 마커(DHT C4·JPG C8·DAC CC 제외한 C0~CF)
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
// 지우는 세그먼트: APP1~APP15(EXIF·XMP·ICC·제조사 정보), COM(주석). APP0(JFIF)은 남긴다.
const isMeta = (m: number) => (m >= 0xe1 && m <= 0xef) || m === 0xfe;

// JPEG 구조를 확인하고 메타데이터 세그먼트를 뺀 바이트를 돌려준다. 구조가 맞지 않으면 null(저장하지 않고 거절).
// 메타데이터 제거는 파일 끝까지 보장한다: SOS 뒤 엔트로피 데이터를 지나 다음 마커가 나오면 다시 세그먼트로 읽는다
// (progressive·여러 스캔 JPEG는 스캔 사이에 DHT 등과 함께 APPn·COM이 끼어들 수 있다). EOI에서 끝내고, 그 뒤 바이트는 버린다.
export function stripJpeg(b: Buffer): { width: number; height: number; data: Buffer } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  let size: { width: number; height: number } | null = null;
  let scanned = false;
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i += 1; // 채움 바이트
      continue;
    }
    if (m === 0xd9) {
      // EOI: 스캔을 하나 이상 지난 뒤에만 정상 끝
      if (!scanned) return null;
      parts.push(b.subarray(i, i + 2));
      return size ? { ...size, data: Buffer.concat(parts) } : null;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0x00) return null; // 세그먼트 자리에 오면 안 되는 마커
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (isSof(m)) {
      if (len < 8) return null;
      size = { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (!isMeta(m)) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
    if (m === 0xda) {
      // SOS: 크기를 안 뒤에만. 엔트로피 데이터는 FF00(바이트 채움)·FFD0~D7(재시작)·FFFF(채움 앞부분)을 빼고 다음 마커 전까지다.
      if (!size || size.width === 0 || size.height === 0) return null;
      const from = i;
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && b[i + 1] !== 0xff && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))) i += 1;
      if (i + 1 >= b.length) return null; // 마커 없이 끝남(EOI 없음)
      parts.push(b.subarray(from, i));
      scanned = true;
    }
  }
  return null;
}

// PNG에서 지우는 보조 덩어리: 텍스트(tEXt·zTXt·iTXt), EXIF(eXIf), 시각(tIME). 나머지(그림·색 정보)는 그대로 둔다.
const PNG_META = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
export function stripPng(b: Buffer): Buffer | null {
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_META.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") return Buffer.concat(parts);
  }
  return null;
}

// 메타데이터가 남았는지(시험·확인용): JPEG APP1 「Exif」, PNG eXIf·텍스트
export function hasImageMetadata(b: Buffer): boolean {
  return b.includes(Buffer.from("Exif\0\0", "latin1")) || ["eXIf", "tEXt", "iTXt", "zTXt"].some((t) => b.includes(Buffer.from(t, "latin1")));
}

// 리뷰 사진 응답. 리뷰가 숨겨지면 공개 주소가 바로 막혀야 해서 짧게(60초)만 캐시한다. 없으면 404.
export function reviewImageResponse(row: { data: Uint8Array; contentType: string } | null, scope: "public" | "private"): Response {
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!row) return new Response("not found", { status: 404, headers: base });
  return new Response(new Uint8Array(row.data), { headers: { ...base, "content-type": row.contentType, "cache-control": `${scope}, max-age=60` } });
}
