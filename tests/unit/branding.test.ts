import sharp from "sharp";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkFavicon, checkOgImage, detectImage, readBodyLimited } from "../../lib/server/branding/image";
import { requestCardSite, requestOrigin } from "../../lib/server/branding/siteUrl";

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: "#ff6600" } }).png().toBuffer();
const jpg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#123456" } }).jpeg().toBuffer();

// PNG 한 장을 담은 ICO(Vista 이후 형식). ICO는 받지 않는다는 확인에만 쓴다
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
function rawPng(w: number, h: number, o: { color?: number; depth?: number; idat?: Buffer[]; plte?: Buffer; extra?: Buffer[] } = {}): Buffer {
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
    ...(o.extra ?? []),
    ...idat.map((d) => chunk("IDAT", d)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("브랜딩 이미지 형식 확인(파일 앞부분 바이트)", () => {
  it("PNG 파비콘은 받고 크기를 읽으며, ICO는 안에 온전한 PNG가 들어 있어도 받지 않는다(Codex 지적 5차)", async () => {
    expect(checkFavicon(await png(512, 512))).toEqual({ ok: true, info: { type: "image/png", width: 512, height: 512 } });
    expect(checkFavicon(icoOf(await png(32, 32)))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(icoOf(await png(256, 256), 256))).toEqual({ ok: false, reason: "unsupported_image" });
    // 정사각형이 아니어도 받는다(화면에서 권장 안내)
    expect(checkFavicon(await png(64, 32))).toMatchObject({ ok: true });
  });

  it("SVG·JPEG·HTML·이름만 바꾼 텍스트·잘린 파일은 파비콘으로 받지 않는다", async () => {
    expect(checkFavicon(SVG)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(await jpg(64, 64))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(Buffer.from("<!doctype html><script>alert(1)</script>"))).toEqual({ ok: false, reason: "unsupported_image" });
    // PNG 시그니처 뒤에 SVG를 붙인 위장 파일(IHDR 없음)
    expect(checkFavicon(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), SVG]))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_file" });
  });

  it("머리만 맞춘 잘린 파일·CRC가 틀린 PNG는 거부한다(Codex 지적)", async () => {
    const full = await png(1200, 630);
    // 시그니처 + 1200×630 IHDR만 있는 33바이트
    expect(checkOgImage(full.subarray(0, 33))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(full.subarray(0, full.length - 12))).toEqual({ ok: false, reason: "unsupported_image" });
    const badCrc = Buffer.from(full);
    badCrc[40] ^= 0xff;
    expect(checkOgImage(badCrc)).toEqual({ ok: false, reason: "unsupported_image" });
    // IEND 뒤에 다른 데이터를 붙인 파일
    expect(checkOgImage(Buffer.concat([full, SVG]))).toEqual({ ok: false, reason: "unsupported_image" });
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
  });

  it("색 번호 PNG: 필터를 되돌린 실제 색 번호가 PLTE 항목 수 밖이면 거부하고, 안이면 받는다(Codex 지적 4차)", async () => {
    const plte4 = Buffer.alloc(3 * 4);
    // 필터 없음(0): 8비트 색 번호 5는 항목 4개 밖
    const row = (filter: number, bytes: number[]) => Buffer.from([filter, ...bytes, ...Array(16 - bytes.length).fill(0)]);
    const indexed = (rows: Buffer[], depth = 8, plte = plte4) => rawPng(16, rows.length, { color: 3, depth, plte, idat: [deflateSync(Buffer.concat(rows))] });
    expect(checkFavicon(indexed(Array.from({ length: 16 }, () => row(0, [5]))))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(indexed(Array.from({ length: 16 }, () => row(0, [3]))))).toMatchObject({ ok: true });
    // Sub 필터(1): 바이트는 모두 작지만 왼쪽 값을 더하면 1,2,3,4 → 넷째 화소가 범위 밖
    expect(checkFavicon(indexed(Array.from({ length: 16 }, () => row(1, [1, 1, 1, 1]))))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(indexed(Array.from({ length: 16 }, () => row(1, [1, 1, 1]))))).toMatchObject({ ok: true });
    // Up 필터(2): 줄마다 1씩 쌓여 넷째 줄에서 4
    expect(checkFavicon(indexed(Array.from({ length: 16 }, () => row(2, [1]))))).toEqual({ ok: false, reason: "unsupported_image" });
    // 2비트 색 번호: 항목 3개인데 색 번호 3(0b11)
    const packed = (b: number) => Buffer.from([0, b, 0, 0, 0]);
    const indexed2 = (b: number) => rawPng(16, 16, { color: 3, depth: 2, plte: Buffer.alloc(9), idat: [deflateSync(Buffer.concat(Array.from({ length: 16 }, () => packed(b))))] });
    expect(checkFavicon(indexed2(0b00_01_10_11))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(indexed2(0b00_01_10_10))).toMatchObject({ ok: true });
    // 실제 도구가 만든 색 번호 PNG(Average·Paeth 등 여러 필터, 인터레이스 포함)는 받는다
    const gradient = sharp(Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => (i * 7) % 256)), { raw: { width: 64, height: 64, channels: 3 } });
    expect(checkFavicon(await gradient.clone().png({ palette: true, colours: 16 }).toBuffer())).toMatchObject({ ok: true });
    expect(checkFavicon(await gradient.clone().png({ palette: true, colours: 4, progressive: true }).toBuffer())).toMatchObject({ ok: true });
    expect(checkFavicon(await gradient.clone().png({ adaptiveFiltering: true }).toBuffer())).toMatchObject({ ok: true });
  });

  it("tRNS: 형식별 길이·위치 규칙을 어기면 거부한다", () => {
    const rgb = (extra: Buffer[]) => rawPng(16, 16, { color: 2, extra, idat: [deflateSync(Buffer.alloc(16 * (1 + 16 * 3)))] });
    expect(checkFavicon(rgb([chunk("tRNS", Buffer.alloc(6))]))).toMatchObject({ ok: true });
    expect(checkFavicon(rgb([chunk("tRNS", Buffer.alloc(4))]))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(rgb([chunk("tRNS", Buffer.alloc(6)), chunk("tRNS", Buffer.alloc(6))]))).toEqual({ ok: false, reason: "unsupported_image" });
    // 알파가 있는 형식(RGBA)에는 tRNS가 없어야 한다
    expect(checkFavicon(rawPng(16, 16, { extra: [chunk("tRNS", Buffer.alloc(6))] }))).toEqual({ ok: false, reason: "unsupported_image" });
    // 색 번호 형식: PLTE 항목 수(4) 이하만
    const pal = (n: number) => rawPng(16, 16, { color: 3, plte: Buffer.alloc(12), extra: [chunk("tRNS", Buffer.alloc(n))], idat: [deflateSync(Buffer.alloc(16 * 17))] });
    expect(checkFavicon(pal(4))).toMatchObject({ ok: true });
    expect(checkFavicon(pal(5))).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("인터레이스(Adam7) PNG는 단계별 길이로 확인해 받는다", async () => {
    const adam7 = await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#123" } }).png({ progressive: true }).toBuffer();
    expect(adam7[28]).toBe(1);
    expect(checkOgImage(adam7)).toMatchObject({ ok: true });
    const icon = await sharp({ create: { width: 37, height: 21, channels: 4, background: "#f00" } }).png({ progressive: true }).toBuffer();
    expect(checkFavicon(icon)).toMatchObject({ ok: true, info: { width: 37, height: 21 } });
  });

  it("모르는 필수 조각·규칙에 맞지 않는 조각 이름은 거부하고, 보조 조각은 건너뛴다(Codex 지적 3차)", () => {
    const withChunk = (type: string) => {
      const base = rawPng(32, 32);
      const iend = base.length - 12;
      return Buffer.concat([base.subarray(0, iend), chunk(type, Buffer.from("x")), base.subarray(iend)]);
    };
    expect(checkFavicon(withChunk("ABCD"))).toEqual({ ok: false, reason: "unsupported_image" });
    // 셋째 글자(예약 비트)가 소문자
    expect(checkFavicon(withChunk("abcd"))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(withChunk("ab1D"))).toEqual({ ok: false, reason: "unsupported_image" });
    // IHDR가 두 번, PLTE가 그림 데이터 뒤·두 번
    expect(checkFavicon(withChunk("IHDR"))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(withChunk("PLTE"))).toEqual({ ok: false, reason: "unsupported_image" });
    const twoPlte = rawPng(32, 32, { color: 2, plte: Buffer.alloc(6), idat: [deflateSync(Buffer.alloc(32 * (1 + 32 * 3)))] });
    const firstIdat = twoPlte.indexOf(Buffer.from("IDAT")) - 4;
    expect(checkFavicon(Buffer.concat([twoPlte.subarray(0, firstIdat), chunk("PLTE", Buffer.alloc(6)), twoPlte.subarray(firstIdat)]))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkFavicon(twoPlte)).toMatchObject({ ok: true });
    // 보조 조각(tEXt·사설 조각)은 받는다
    expect(checkFavicon(withChunk("tEXt"))).toMatchObject({ ok: true });
    expect(checkFavicon(withChunk("prVt"))).toMatchObject({ ok: true });
  });

  it("JPEG는 정상 파일이어도 받지 않는다(그림 데이터까지 확인할 수 없어 PNG만, MASTER 결정)", async () => {
    expect(checkOgImage(await jpg(1200, 630))).toEqual({ ok: false, reason: "unsupported_image" });
    // 시작 표식·프레임·스캔·끝 표식만 맞춘 38바이트(Codex 지적 3차)
    const tiny = Buffer.from("ffd8ffc0000b080276 04b001011100ffda0008010100003f0000ffd9".replace(/ /g, ""), "hex");
    expect(checkOgImage(tiny)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(detectImage(tiny)).toBeNull();
  });

  it("파비콘 256KB 초과, 한 변 16px 미만·1024px 초과 PNG는 거부한다", async () => {
    const big = Buffer.alloc(256 * 1024 + 1);
    expect(checkFavicon(big)).toEqual({ ok: false, reason: "file_too_large" });
    expect(checkFavicon(await png(8, 8))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkFavicon(await png(2048, 2048))).toEqual({ ok: false, reason: "wrong_image_size" });
  });

  it("공유 카드 이미지는 1200×630 PNG만, 2MB까지", async () => {
    expect(checkOgImage(await png(1200, 630))).toMatchObject({ ok: true, info: { type: "image/png" } });
    expect(checkOgImage(await png(1200, 600))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkOgImage(icoOf(await png(32, 32)))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(SVG)).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkOgImage(Buffer.alloc(2 * 1024 * 1024 + 1))).toEqual({ ok: false, reason: "file_too_large" });
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

describe("공유 카드에 인쇄하는 플랫폼 주소", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("신뢰 프록시의 공인 호스트를 쓰고 내부·잘못된 호스트는 인쇄하지 않는다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    try {
      expect(requestCardSite(h({ host: "0.0.0.0:3000", "x-forwarded-host": "test.on-aircue.com", "x-forwarded-proto": "https" }))).toBe("test.on-aircue.com");
      expect(requestCardSite(h({ host: "0.0.0.0:3000" }))).toBe("");
      expect(requestCardSite(h({ host: "evil.example" }))).toBe("");
      expect(requestCardSite(h({ host: "app:3000", "x-forwarded-host": "evil.example/path" }))).toBe("");
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS;
    }
  });
  it("신뢰 프록시가 아니면 위조한 전달 호스트를 무시한다", () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    expect(requestCardSite(h({ host: "test.on-aircue.com", "x-forwarded-host": "evil.example" }))).toBe("test.on-aircue.com");
    expect(requestCardSite(h({ host: "192.168.1.2:3000" }))).toBe("");
  });
});
