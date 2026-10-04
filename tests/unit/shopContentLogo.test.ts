import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES, checkLogo } from "../../lib/server/shop-content/logo";
import { brokenPng, jpeg, png, svg, svgInPng } from "./shopContentFixtures";

describe("SA-060 쇼핑몰 로고 검사", () => {
  it("정사각형 PNG 512~1440px만 받는다", () => {
    expect(checkLogo(png(512, 512))).toEqual({ ok: true, width: 512 });
    expect(checkLogo(png(1440, 1440))).toEqual({ ok: true, width: 1440 });
    expect(checkLogo(png(511, 511))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkLogo(png(1441, 1441))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkLogo(png(600, 512))).toEqual({ ok: false, reason: "not_square" });
  });

  it("PNG가 아니거나 풀리지 않으면 거부, 빈 파일·2MB 초과 거부", () => {
    expect(checkLogo(jpeg(600, 600))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkLogo(svg())).toEqual({ ok: false, reason: "unsupported_image" });
    // PNG 머리(200×200) 뒤에 SVG를 붙인 위장 파일: 풀기 전에 크기로 먼저 거부
    expect(checkLogo(svgInPng()).ok).toBe(false);
    // 크기는 맞지만 그림 데이터가 풀리지 않는 PNG
    expect(checkLogo(brokenPng(512, 512))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(checkLogo(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_file" });
    expect(checkLogo(Buffer.alloc(LOGO_MAX_BYTES + 1))).toEqual({ ok: false, reason: "file_too_large" });
  });

  it("16비트 PNG 로고는 「8비트 PNG로 저장」 사유로 거부(배너·팝업과 같은 checkPng, Codex 4176225063)", () => {
    // 16비트 RGBA 1200×1200은 풀린 크기 11,521,200바이트로 브랜딩 검사기 상한(8,400,000)을 넘는다
    expect(checkLogo(png(1200, 1200, [1, 2, 3], { depth: 16, color: 6 }))).toEqual({ ok: false, reason: "png_16bit" });
    expect(checkLogo(png(600, 600, [1, 2, 3], { depth: 16 }))).toEqual({ ok: false, reason: "png_16bit" });
    // 8비트 RGBA 1440×1440은 받는다(풀린 크기 8,295,840바이트)
    expect(checkLogo(png(1440, 1440, [1, 2, 3], { color: 6 }))).toEqual({ ok: true, width: 1440 });
  });
});
