import { checkProductImage, PRODUCT_IMAGE_MAX_BYTES } from "../products/images";

// 리뷰 사진 검사(대표님 지시 2026-10-04: 상품 사진과 같은 기준 「JPG·PNG·WEBP, 장당 5MB, 위치정보(EXIF) 제거」).
// 형식·크기 확인과 JPG·WEBP 메타데이터 제거는 상품 사진의 공통 함수(products/images.ts checkProductImage → imageFormats.ts)를 그대로 쓴다(복사하지 않음).
// PNG는 공통 함수가 그림 데이터까지 검사만 하고 바이트를 그대로 두므로, 리뷰는 PNG의 텍스트·eXIf·tIME 덩어리를 서버에서 한 번 더 지운다.
// 화면은 고른 사진을 canvas로 긴 변 1600px JPEG로 줄여 올린다(용량을 줄이는 용도). 서버는 어떤 요청이 와도 같은 검사를 거친다.
export const REVIEW_IMAGE_MAX_BYTES = PRODUCT_IMAGE_MAX_BYTES;
export const REVIEW_IMAGES_PER_REVIEW = 5;

export type ReviewImageRejection = "empty_file" | "file_too_large" | "unsupported_image" | "wrong_image_size" | "png_16bit" | "png_too_large";
export type ReviewImage = { type: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number; data: Buffer };

export function checkReviewImage(b: Buffer): { ok: true; image: ReviewImage } | { ok: false; reason: ReviewImageRejection } {
  const r = checkProductImage(b);
  if (!r.ok) return r;
  if (r.contentType !== "image/png") return { ok: true, image: { type: r.contentType, width: r.width, height: r.height, data: r.bytes } };
  const data = stripPng(r.bytes);
  if (!data) return { ok: false, reason: "unsupported_image" };
  return { ok: true, image: { type: "image/png", width: r.width, height: r.height, data } };
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

// 메타데이터가 남았는지(시험·확인용): JPEG APP1 「Exif」, PNG eXIf·텍스트, WEBP EXIF·XMP 청크
export function hasImageMetadata(b: Buffer): boolean {
  return b.includes(Buffer.from("Exif\0\0", "latin1")) || ["eXIf", "tEXt", "iTXt", "zTXt", "EXIF", "XMP "].some((t) => b.includes(Buffer.from(t, "latin1")));
}

// 리뷰 사진 응답. 리뷰가 숨겨지면 공개 주소가 바로 막혀야 해서 짧게(60초)만 캐시한다. 없으면 404.
export function reviewImageResponse(row: { data: Uint8Array; contentType: string } | null, scope: "public" | "private"): Response {
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!row) return new Response("not found", { status: 404, headers: base });
  return new Response(new Uint8Array(row.data), { headers: { ...base, "content-type": row.contentType, "cache-control": `${scope}, max-age=60` } });
}
