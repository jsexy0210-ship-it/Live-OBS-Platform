import { describe, expect, it } from "vitest";
import { SHOP_IMAGE_MAX_BYTES, checkShopImage, pngRawSize } from "../../lib/server/shop-content/image";
import { normalizeLink, resolveLink } from "../../lib/server/shop-content/link";
import { brokenPng, jpeg, png, svg, svgInPng } from "./shopContentFixtures";

describe("SA-064·SA-065 배너·팝업 링크", () => {
  it("쇼핑몰 안 경로와 http(s) 주소만 받는다", () => {
    expect(normalizeLink("/products/abc?x=1#y")).toEqual({ ok: true, value: "/products/abc?x=1#y" });
    expect(normalizeLink("/이벤트")).toEqual({ ok: true, value: "/%EC%9D%B4%EB%B2%A4%ED%8A%B8" });
    expect(normalizeLink("https://example.com/a")).toEqual({ ok: true, value: "https://example.com/a" });
    expect(normalizeLink("HTTP://Example.com")).toEqual({ ok: true, value: "http://example.com/" });
    expect(normalizeLink("")).toEqual({ ok: true, value: null });
    expect(normalizeLink(null)).toEqual({ ok: true, value: null });
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "mailto:a@b.c",
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "https://user:pw@example.com",
    "products/abc",
    "https://",
    "/a\nb",
    "ftp://example.com",
  ])("거부: %j", (v) => {
    expect(normalizeLink(v).ok).toBe(false);
  });

  it("경로를 벗어나도 같은 쇼핑몰 안 경로로 정리된다", () => {
    expect(normalizeLink("/../../admin")).toEqual({ ok: true, value: "/admin" });
    expect(resolveLink("my-shop", "/admin")).toEqual({ href: "/shop/my-shop/admin", external: false });
    expect(resolveLink("my-shop", "/")).toEqual({ href: "/shop/my-shop", external: false });
    expect(resolveLink("my-shop", "https://example.com/")).toEqual({ href: "https://example.com/", external: true });
  });

  it("500자를 넘으면 거부", () => {
    expect(normalizeLink(`/${"a".repeat(500)}`).ok).toBe(false);
  });
});

describe("배너·팝업 이미지(PNG만)", () => {
  it("PNG를 바이트로 확인하고 크기를 읽는다", () => {
    expect(checkShopImage(png(1200, 400))).toEqual({ ok: true, info: { type: "image/png", width: 1200, height: 400 } });
    expect(checkShopImage(png(750, 750))).toEqual({ ok: true, info: { type: "image/png", width: 750, height: 750 } });
  });

  it("JPEG·SVG·GIF·위장 파일·풀리지 않는 PNG는 거부", () => {
    expect(checkShopImage(jpeg(1200, 400))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkShopImage(svg())).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkShopImage(svgInPng())).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkShopImage(brokenPng())).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkShopImage(Buffer.from("GIF89a"))).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("빈 파일·2MB 초과·크기 범위 밖은 거부", () => {
    expect(checkShopImage(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_file" });
    expect(SHOP_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(checkShopImage(Buffer.alloc(SHOP_IMAGE_MAX_BYTES + 1))).toEqual({ ok: false, reason: "file_too_large" });
    expect(checkShopImage(png(99, 300))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkShopImage(png(2001, 600))).toEqual({ ok: false, reason: "wrong_image_size" });
    // 한 변은 범위 안이지만 1920×1080 화소를 넘으면 풀기 전에 크기로 거부. 1920×1080은 받는다(PC 배너 표준)
    expect(checkShopImage(png(1920, 1081))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkShopImage(png(1920, 1080))).toEqual({ ok: true, info: { type: "image/png", width: 1920, height: 1080 } });
    expect(checkShopImage(png(1921, 1080))).toEqual({ ok: false, reason: "wrong_image_size" });
  });

  it("16비트 PNG는 「8비트 PNG로 저장」 사유로 거부(브랜딩 검사기 풀기 상한에 걸려 「PNG만」으로 잘못 안내되지 않게)", () => {
    // Codex 4176099331: 16비트 RGBA 1920×600은 풀린 크기 9,216,600바이트로 상한(8,400,000)을 넘는다
    expect(pngRawSize({ width: 1920, height: 600, depth: 16, color: 6, interlace: 0 })).toBe(9_216_600);
    expect(checkShopImage(png(1920, 600, [1, 2, 3], { depth: 16, color: 6 }))).toEqual({ ok: false, reason: "png_16bit" });
    // 상한 안이어도 16비트는 받지 않는다(안내를 한 가지로)
    expect(checkShopImage(png(200, 200, [1, 2, 3], { depth: 16 }))).toEqual({ ok: false, reason: "png_16bit" });
  });

  it("8비트 RGBA는 화소 상한(1920×1080)까지 인터레이스를 포함해 풀기 상한 안에 들어간다", () => {
    expect(checkShopImage(png(1920, 1080, [1, 2, 3], { color: 6 }))).toEqual({ ok: true, info: { type: "image/png", width: 1920, height: 1080 } });
    expect(pngRawSize({ width: 1920, height: 1080, depth: 8, color: 6, interlace: 0 })).toBe(8_295_480);
    expect(pngRawSize({ width: 1920, height: 1080, depth: 8, color: 6, interlace: 1 })).toBeLessThan(8_400_000);
    expect(pngRawSize({ width: 2000, height: 1036, depth: 8, color: 6, interlace: 1 })).toBeLessThan(8_400_000);
  });
});
