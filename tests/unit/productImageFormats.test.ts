import { describe, expect, it } from "vitest";
import { checkProductImage } from "../../lib/server/products/images";
import { stripJpeg, stripWebp } from "../../lib/server/products/imageFormats";
import { jpeg, webp } from "./productImageFormatsFixtures";

// 상품 사진 JPG·WEBP: 메타데이터(위치정보)를 잘라 저장하고, 구조가 어긋나면 거절(MASTER 결정 2026-10-04)
const has = (b: Buffer, s: string) => b.includes(Buffer.from(s, "latin1"));

describe("JPG", () => {
  it("EXIF·XMP·주석·EOI 뒤 바이트를 지우고 JFIF·ICC·표·그림 데이터는 그대로 둔다", () => {
    const src = jpeg(1200, 900, { xmp: true, comment: true, trailer: Buffer.from("trailing GPS data", "latin1") });
    expect(has(src, "GPSLatitude")).toBe(true);
    const r = stripJpeg(src);
    expect(r).toMatchObject({ width: 1200, height: 900 });
    const out = r!.bytes;
    for (const s of ["Exif", "GPS", "xmpmeta", "made at home", "trailing"]) expect(has(out, s), s).toBe(false);
    for (const s of ["JFIF", "ICC_PROFILE"]) expect(has(out, s), s).toBe(true);
    expect(out.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]))).toBe(true);
    expect([...out.subarray(0, 2), ...out.subarray(-2)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    // 다시 넣어도 같은 결과(이미 깨끗한 파일은 그대로)
    expect(stripJpeg(out)!.bytes.equals(out)).toBe(true);
    expect(stripJpeg(jpeg(1200, 900, { exif: false }))!.bytes.equals(jpeg(1200, 900, { exif: false }))).toBe(true);
  });

  it("SOF·EOI가 없거나 잘린 파일은 거절한다", () => {
    const good = jpeg(300, 300);
    expect(stripJpeg(jpeg(300, 300, { noEoi: true }))).toBeNull();
    expect(stripJpeg(jpeg(300, 300, { noSof: true }))).toBeNull();
    for (const cut of [3, 10, 40, good.length - 3]) expect(stripJpeg(good.subarray(0, cut)), String(cut)).toBeNull();
    expect(stripJpeg(Buffer.concat([good.subarray(0, 4), Buffer.from([0xff, 0xff]), good.subarray(6)]))).toBeNull(); // 길이 깨짐
  });
});

describe("WEBP", () => {
  it("EXIF·XMP 청크를 빼고 VP8X 표시를 끄고 RIFF 크기를 고친다(손실·무손실)", () => {
    for (const lossless of [false, true]) {
      const src = webp(800, 600, { lossless });
      const r = stripWebp(src);
      expect(r).toMatchObject({ width: 800, height: 600 });
      const out = r!.bytes;
      expect(has(out, "GPS") || has(out, "EXIF") || has(out, "XMP ")).toBe(false);
      expect(out.readUInt32LE(4)).toBe(out.length - 8);
      expect(out[20] & 0x0c).toBe(0);
      expect(stripWebp(out)!.bytes.equals(out)).toBe(true);
    }
  });

  it("RIFF 크기가 안 맞거나 움직이는 WEBP·잘린 파일은 거절한다", () => {
    expect(stripWebp(webp(300, 300, { badSize: true }))).toBeNull();
    expect(stripWebp(webp(300, 300, { animated: true }))).toBeNull();
    const good = webp(300, 300);
    expect(stripWebp(good.subarray(0, good.length - 5))).toBeNull();
  });
});

describe("checkProductImage", () => {
  it("형식은 바이트로 정하고, 크기 밖·5MB 넘음은 거절한다", () => {
    expect(checkProductImage(jpeg(500, 400))).toMatchObject({ ok: true, contentType: "image/jpeg", width: 500, height: 400 });
    expect(checkProductImage(webp(500, 400))).toMatchObject({ ok: true, contentType: "image/webp" });
    expect(checkProductImage(jpeg(99, 400))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkProductImage(webp(4001, 400, { lossless: true }))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkProductImage(Buffer.concat([jpeg(500, 400), Buffer.alloc(5 * 1024 * 1024)]))).toEqual({ ok: false, reason: "file_too_large" });
    expect(checkProductImage(jpeg(500, 400, { noEoi: true }))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkProductImage(Buffer.from("GIF89a....", "latin1"))).toEqual({ ok: false, reason: "unsupported_image" });
  });
});
