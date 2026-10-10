import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement as h } from "react";
import wawoff2 from "wawoff2";
import type { BrandingTarget } from "./store";
import { loadOgFontFiles, OG_HEIGHT, OG_WIDTH, withoutTables } from "../shop/ogCard";

// 마스터·파트너스 기본 카드(OG-001·002). 쇼핑몰 기본 카드와 글꼴 도구만 공유하고 대상별 보드 색·부제·로고 구성을 쓴다.
const CACHE_MAX = 20;
const rendered = new Map<string, Promise<Buffer>>();
// 화면 서체와 같은 wanted-sans@1.0.3(OFL)의 정적 800·900. 가변 파일의 표를 제거하면 기본 굵기로만 출력된다.
const heavyFonts = Promise.all(([800, 900] as const).map(async (weight) => {
  const file = weight === 800 ? "WantedSans-ExtraBold.woff2" : "WantedSans-Black.woff2";
  const woff2 = await readFile(path.join(process.cwd(), "public/fonts/wanted-sans/branding", file));
  const data = withoutTables(Buffer.from(await wawoff2.decompress(woff2)), new Set(["GSUB", "GPOS", "GDEF"]));
  return { name: "Wanted Sans", data, weight, style: "normal" as const };
}));
const DESIGN: Record<BrandingTarget, { label: string; subtitle: string; from: string; to: string }> = {
  admin: { label: "마스터 관리자", subtitle: "파트너스 · 구독 · 결제 · 운영 상태 통합 관리", from: "#0f766e", to: "#134e4a" },
  seller: { label: "파트너스 관리자", subtitle: "방송 주문대기와 쇼핑몰 통합 운영", from: "#5b3df6", to: "#3b1fb8" },
  landing: { label: "서비스 소개", subtitle: "쇼핑몰부터 라이브 판매까지", from: "#4F46E5", to: "#171A24" },
};

export function renderBrandingCard(target: BrandingTarget, title: string, site: string): Promise<Buffer> {
  const key = `${target}\0${title}\0${site}`;
  let png = rendered.get(key);
  if (!png) {
    png = (async () => {
      const design = DESIGN[target];
      const landing = target === "landing";
      const brand = landing ? "StreamShop" : "ONQ";
      const symbol = landing ? `data:image/png;base64,${(await readFile(path.join(process.cwd(), "public/branding/streamshop-symbol.png"))).toString("base64")}` : null;
      const fonts = [
        ...await loadOgFontFiles(`${title}${design.subtitle}${design.label}${brand} Q${site}OnAirCue`),
        ...await heavyFonts,
      ];
      const card = h(
        "div",
        {
          style: {
            width: OG_WIDTH,
            height: OG_HEIGHT,
            boxSizing: "border-box",
            padding: 72,
            background: `linear-gradient(135deg, ${design.from} 0%, ${design.to} 100%)`,
            color: "#fff",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            fontFamily: "Wanted Sans",
            position: "relative",
            overflow: "hidden",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 14 } },
          symbol ? h("img", { src: symbol, width: 40, height: 40, style: { objectFit: "contain" } }) : h("div", { style: { width: 40, height: 40, borderRadius: 12, background: "#fff", color: design.from, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 22 } }, "Q"),
          h("span", { style: { fontWeight: 800, fontSize: 26, letterSpacing: "-0.01em" } }, brand),
          h("span", { style: { fontSize: 18, opacity: 0.85, marginLeft: 4 } }, design.label),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 880 } },
          h("span", { style: { fontWeight: 800, fontSize: 64, lineHeight: 1.15, letterSpacing: "-0.02em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, title),
          h("span", { style: { fontSize: 28, lineHeight: 1.4, opacity: 0.9, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, design.subtitle),
        ),
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 22, opacity: 0.8 } }, h("span", null, site), h("span", null, landing ? "StreamShop" : "OnAirCue")),
        h("div", { style: { position: "absolute", right: -120, bottom: -160, width: 420, height: 420, borderRadius: 210, background: "rgba(255,255,255,0.08)" } }),
      );
      const response = new ImageResponse(card, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
      return Buffer.from(await response.arrayBuffer());
    })();
    png.catch(() => rendered.delete(key));
    rendered.set(key, png);
    if (rendered.size > CACHE_MAX) rendered.delete(rendered.keys().next().value!);
  }
  return png;
}
