import type { Metadata } from "next";
import { headers } from "next/headers";
import { prisma } from "../db";
import { BRANDING_DEFAULTS, brandingMeta, defaultFavicon, generatedCardVersion, ogImageUrl, type BrandingMeta } from "./service";
import { requestOrigin } from "./siteUrl";
import type { BrandingTarget } from "./store";

// 관리자 화면 layout의 generateMetadata: 파비콘(<link rel="icon">)·og:title·og:description·og:image·twitter:card.
// 요청 헤더를 읽으므로 화면은 요청마다 그린다(빌드 때 DB를 읽지 않음). DB를 못 읽으면 기본값(앱 공통 메타)을 그대로 쓴다.
// 화면마다 정한 title이 있으면 그 값이 우선한다(Next 메타데이터 병합).
export async function brandingMetadata(target: BrandingTarget): Promise<Metadata> {
  const origin = requestOrigin(await headers());
  let meta: BrandingMeta;
  try {
    meta = await brandingMeta(prisma, target);
  } catch (e) {
    console.error(e);
    if (target !== "landing") return {};
    meta = { ...BRANDING_DEFAULTS.landing, favicon: null, image: { url: ogImageUrl(target, generatedCardVersion(BRANDING_DEFAULTS.landing.title, target)), width: 1200, height: 630 } };
  }
  const description = meta.description ?? undefined;
  const fallback = defaultFavicon(target);
  const iconUrl = (url: string) => target === "landing" && origin ? new URL(url, origin).toString() : url;
  const images = origin ? [{ url: new URL(meta.image.url, origin).toString(), width: meta.image.width, height: meta.image.height }] : undefined;
  return {
    title: meta.title,
    description,
    // 올린 파비콘이 없으면 기본 ONQ 아이콘을 직접 넣는다(파일 기반 app/icon.*에 기대지 않음)
    icons: meta.favicon
      ? { icon: [{ url: iconUrl(meta.favicon.url), type: meta.favicon.type }], shortcut: [{ url: iconUrl(meta.favicon.url), type: meta.favicon.type }], apple: [{ url: iconUrl(meta.favicon.url) }] }
      : {
          icon: [{ url: iconUrl(fallback.url), type: fallback.type, ...(target !== "landing" && { sizes: "32x32" }) }],
          shortcut: [{ url: iconUrl(fallback.url), type: fallback.type }],
          apple: [{ url: iconUrl(fallback.appleUrl), ...(target !== "landing" && { sizes: "180x180" }) }],
        },
    openGraph: { type: "website", title: meta.title, description, ...(images && { images }) },
    twitter: { card: "summary_large_image", title: meta.title, description, ...(images && { images: images.map((i) => i.url) }) },
  };
}
