import sharp from "sharp";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkFavicon, checkOgImage, detectImage, readBodyLimited } from "../../lib/server/branding/image";
import { requestOrigin } from "../../lib/server/branding/siteUrl";

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: "#ff6600" } }).png().toBuffer();
const jpg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#123456" } }).jpeg().toBuffer();

// PNG 한 장을 담은 ICO(Vista 이후 형식)
function icoOf(inner: Buffer, side = 32): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = side % 256;
  head[7] = side % 256;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(inner.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, inner]);
}

// 손으로 짜는 PNG(내용 검사 회귀용)
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
  return Buffer.concat([head, data, crc]);
}
function rawPng(w: number, h: number, o: { color?: number; depth?: number; idat?: Buffer[]; plte?: Buffer } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = o.depth ?? 8;
  ihdr[9] = o.color ?? 6;
  const rows = Buffer.alloc(h * (1 + w * 4));
  const idat = o.idat ?? [deflateSync(rows)];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(o.plte ? [chunk("PLTE", o.plte)] : []),
    ...idat.map((d) => chunk("IDAT", d)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("브랜딩 이미지 형식 확인(파일 앞부분 바이트)", () => {
  it("PNG·ICO 파비콘은 받고 크기를 읽는다", async () => {
    expect(checkFavicon(await png(512, 512))).toEqual({ ok: true, info: { type: "image/png", width: 512, height: 512 } });
    expect(checkFavicon(icoOf(await png(32, 32)))).toEqual({ ok: true, info: { type: "image/x-icon", width: 32, height: 32 } });
    // 0은 256px
    expect(checkFavicon(icoOf(await png(256, 256), 256))).toMatchObject({ ok: true, info: { width: 256, height: 256 } });
    // 정사각형이 아니어도 받는다(화면에서 권장 안내)
    expect(checkFavicon(await png(64, 32))).toMatchObject({ ok: true });
  });

  it("SVG·JPEG·HTML·이름만 바꾼 텍스트·잘린 파일은 파비콘으로 받지 않는다", async () => {
    expect(checkFavicon(SVG)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(await jpg(64, 64))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(Buffer.from("<!doctype html><script>alert(1)</script>"))).toEqual({ ok: false, reason: "unsupported_image" });
    // PNG 시그니처 뒤에 SVG를 붙인 위장 파일(IHDR 없음)
    expect(checkFavicon(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), SVG]))).toEqual({ ok: false, reason: "unsupported_image" });
    // ICO 머리만 있고 이미지 범위가 파일 밖
    const broken = icoOf(await png(32, 32)).subarray(0, 40);
    expect(checkFavicon(broken)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_file" });
  });

  it("머리만 맞춘 잘린 파일·CRC가 틀린 PNG·EOI 없는 JPEG·깨진 BMP 아이콘은 거부한다(Codex 지적)", async () => {
    const full = await png(1200, 630);
    // 시그니처 + 1200×630 IHDR만 있는 33바이트
    expect(checkOgImage(full.subarray(0, 33))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(full.subarray(0, full.length - 12))).toEqual({ ok: false, reason: "unsupported_image" });
    const badCrc = Buffer.from(full);
    badCrc[40] ^= 0xff;
    expect(checkOgImage(badCrc)).toEqual({ ok: false, reason: "unsupported_image" });
    // IEND 뒤에 다른 데이터를 붙인 파일
    expect(checkOgImage(Buffer.concat([full, SVG]))).toEqual({ ok: false, reason: "unsupported_image" });
    const j = await jpg(1200, 630);
    expect(checkOgImage(j.subarray(0, 200))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(j.subarray(0, j.length - 2))).toEqual({ ok: false, reason: "unsupported_image" });
    // ICO 안의 PNG가 잘림
    const inner = await png(32, 32);
    expect(checkFavicon(icoOf(inner.subarray(0, 40)))).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("PNG 내용 검사: 빈 IDAT·zlib이 아닌 데이터·길이가 다른 데이터·잘못된 필터·색 형식 규칙을 거부한다(Codex 지적 2차)", async () => {
    // 정상 손 PNG는 받는다(검사기 자체 확인)
    expect(checkFavicon(rawPng(32, 32))).toEqual({ ok: true, info: { type: "image/png", width: 32, height: 32 } });
    // 길이 0인 IDAT(이전 코드는 받음)
    expect(checkOgImage(rawPng(1200, 630, { idat: [Buffer.alloc(0)] }))).toEqual({ ok: false, reason: "unsupported_image" });
    // zlib이 아닌 데이터
    expect(checkFavicon(rawPng(32, 32, { idat: [Buffer.from("not a zlib stream at all")] }))).toEqual({ ok: false, reason: "unsupported_image" });
    // 풀린 길이가 모자람·넘침(압축 폭탄 포함)
    expect(checkFavicon(rawPng(32, 32, { idat: [deflateSync(Buffer.alloc(10))] }))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(rawPng(32, 32, { idat: [deflateSync(Buffer.alloc(64 * 1024 * 1024))] }))).toEqual({ ok: false, reason: "unsupported_image" });
    // 줄 필터 바이트가 0~4 밖
    const badFilter = Buffer.alloc(32 * (1 + 32 * 4));
    badFilter[0] = 5;
    expect(checkFavicon(rawPng(32, 32, { idat: [deflateSync(badFilter)] }))).toEqual({ ok: false, reason: "unsupported_image" });
    // 여러 IDAT로 나눠도 이어 풀면 받는다
    const whole = deflateSync(Buffer.alloc(32 * (1 + 32 * 4)));
    expect(checkFavicon(rawPng(32, 32, { idat: [whole.subarray(0, 5), whole.subarray(5)] }))).toMatchObject({ ok: true });
    // 색 형식·비트 깊이 조합이 틀림(RGBA 4비트)
    expect(checkFavicon(rawPng(32, 32, { depth: 4 }))).toEqual({ ok: false, reason: "unsupported_image" });
    // 색 번호 형식(3)은 PLTE가 있어야 한다
    const indexed = (plte?: Buffer) => rawPng(32, 32, { color: 3, plte, idat: [deflateSync(Buffer.alloc(32 * 33))] });
    expect(checkFavicon(indexed())).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(indexed(Buffer.alloc(3 * 4)))).toMatchObject({ ok: true });
    expect(checkFavicon(indexed(Buffer.alloc(3 * 257)))).toEqual({ ok: false, reason: "unsupported_image" });
    // ICO 안의 PNG도 같은 검사를 거친다
    expect(checkFavicon(icoOf(rawPng(32, 32, { idat: [Buffer.alloc(0)] })))).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("인터레이스(Adam7) PNG는 단계별 길이로 확인해 받는다", async () => {
    const adam7 = await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#123" } }).png({ progressive: true }).toBuffer();
    expect(adam7[28]).toBe(1);
    expect(checkOgImage(adam7)).toMatchObject({ ok: true });
    const icon = await sharp({ create: { width: 37, height: 21, channels: 4, background: "#f00" } }).png({ progressive: true }).toBuffer();
    expect(checkFavicon(icon)).toMatchObject({ ok: true, info: { width: 37, height: 21 } });
  });

  it("JPEG 내용 검사: 스캔 데이터가 없거나 구성 요소·표본 비율이 틀리면 거부한다", async () => {
    const j = await jpg(1200, 630);
    const sos = j.indexOf(Buffer.from([0xff, 0xda]));
    const sosEnd = sos + 2 + j.readUInt16BE(sos + 2);
    // SOS 머리 바로 뒤에 EOI(그림 데이터 없음)
    expect(checkOgImage(Buffer.concat([j.subarray(0, sosEnd), Buffer.from([0xff, 0xd9])]))).toEqual({ ok: false, reason: "unsupported_image" });
    const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
    const twoComponents = Buffer.from(j);
    twoComponents[sof + 9] = 2;
    expect(checkOgImage(twoComponents)).toEqual({ ok: false, reason: "unsupported_image" });
    const zeroSampling = Buffer.from(j);
    zeroSampling[sof + 11] = 0x00;
    expect(checkOgImage(zeroSampling)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(j)).toMatchObject({ ok: true });
  });

  it("BMP를 담은 ICO는 크기가 맞으면 받고, 데이터가 모자라면 거부한다", () => {
    const side = 16;
    const dib = Buffer.alloc(40 + side * side * 4 + 4 * side);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(side, 4);
    dib.writeInt32LE(side * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    expect(checkFavicon(icoOf(dib, side))).toEqual({ ok: true, info: { type: "image/x-icon", width: 16, height: 16 } });
    expect(checkFavicon(icoOf(dib.subarray(0, 100), side))).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("파비콘 256KB 초과, 한 변 16px 미만·1024px 초과 PNG는 거부한다", async () => {
    const big = Buffer.alloc(256 * 1024 + 1);
    expect(checkFavicon(big)).toEqual({ ok: false, reason: "file_too_large" });
    expect(checkFavicon(await png(8, 8))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkFavicon(await png(2048, 2048))).toEqual({ ok: false, reason: "wrong_image_size" });
  });

  it("공유 카드 이미지는 1200×630 PNG·JPEG만, 2MB까지", async () => {
    expect(checkOgImage(await png(1200, 630))).toMatchObject({ ok: true, info: { type: "image/png" } });
    expect(checkOgImage(await jpg(1200, 630))).toEqual({ ok: true, info: { type: "image/jpeg", width: 1200, height: 630 } });
    expect(checkOgImage(await png(1200, 600))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkOgImage(icoOf(await png(32, 32)))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(SVG)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(Buffer.alloc(2 * 1024 * 1024 + 1))).toEqual({ ok: false, reason: "file_too_large" });
  });

  it("JPEG는 EXIF 등 앞 블록을 건너 프레임 크기를 읽는다", async () => {
    const withExif = await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#000" } }).withMetadata({ exif: { IFD0: { Copyright: "x" } } }).jpeg({ progressive: true }).toBuffer();
    expect(detectImage(withExif)).toEqual({ type: "image/jpeg", width: 1200, height: 630 });
  });

  it("본문은 한도까지만 읽고, 넘으면(선언 길이·실제 길이) null", async () => {
    const req = (body: Buffer, len?: string) => new Request("http://x/", { method: "PUT", body: new Uint8Array(body), headers: len ? { "content-length": len } : {} });
    expect(await readBodyLimited(req(Buffer.alloc(10)), 10)).toHaveLength(10);
    expect(await readBodyLimited(req(Buffer.alloc(11)), 10)).toBeNull();
    expect(await readBodyLimited(req(Buffer.alloc(5), "999"), 10)).toBeNull();
  });
});

describe("공유 메타 절대 주소의 기준 주소", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("신뢰 프록시가 없으면 X-Forwarded-Host를 무시하고 Host를 쓴다", () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    expect(requestOrigin(h({ host: "test.on-aircue.com", "x-forwarded-host": "evil.example" }))?.toString()).toBe("http://test.on-aircue.com/");
    expect(requestOrigin(h({ host: "localhost:3000" }))?.toString()).toBe("http://localhost:3000/");
  });
  it("신뢰 프록시면 X-Forwarded-Host·Proto를 쓴다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    try {
      expect(requestOrigin(h({ host: "app:3000", "x-forwarded-host": "test.on-aircue.com", "x-forwarded-proto": "https" }))?.toString()).toBe("https://test.on-aircue.com/");
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });
  it("호스트 모양이 이상하면 null(og:image를 빼고 내보냄)", () => {
    expect(requestOrigin(h({ host: "evil.com/path" }))).toBeNull();
    expect(requestOrigin(h({ host: "a b" }))).toBeNull();
    expect(requestOrigin(h({}))).toBeNull();
    // 정규식은 통과하지만 URL을 만들 수 없는 포트(Codex 지적)
    expect(requestOrigin(h({ host: "example.com:99999" }))).toBeNull();
  });
});
