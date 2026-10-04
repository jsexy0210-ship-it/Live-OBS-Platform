import type { Metadata } from "next";
import { headers } from "next/headers";
import { prisma } from "../../../../lib/server/db";
import { shopShareMeta } from "../../../../lib/server/shop/sharePreview";

type Params = { params: Promise<{ slug: string }> };

const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

// 공유 서비스에 줄 절대 주소의 기준. 요청 검사(lib/server/http/route.ts assertSameOrigin)와 같은 규칙으로,
// 신뢰 프록시(TRUSTED_PROXY_HOPS)가 설정된 경우에만 X-Forwarded-Host·Proto를 믿는다. 형식이 틀린 호스트면 null(이미지 주소를 만들지 않는다).
function siteOrigin(h: Headers): URL | null {
  const trusted = Number(process.env.TRUSTED_PROXY_HOPS ?? "0") > 0;
  const host = ((trusted ? h.get("x-forwarded-host") : null) ?? h.get("host") ?? "").split(",")[0].trim();
  if (!HOST.test(host)) return null;
  const forwarded = trusted ? h.get("x-forwarded-proto")?.split(",")[0].trim() : null;
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  return new URL(`${proto}://${host}`);
}

// 쇼핑몰 공개 페이지 공통 공유 미리보기(SA-060): 운영 중인 쇼핑몰이면 og:title·og:description·og:image를 쇼핑몰 설정(제목·설명)과
// 서버가 그리는 기본 카드(/api/shop/{slug}/og.png)로 채운다. 잠겼거나 없는 쇼핑몰은 기본값(ONQ)을 그대로 쓴다.
// 화면마다 정한 title(예: 회원가입 · 쇼핑몰 이름)은 그 화면 값이 우선한다. 파비콘은 쇼핑몰 파비콘 업로드 전까지 ONQ 기본(app/icon.svg).
// 상품 상세 화면이 생기면 그 화면에서 shopShareMeta(slug, productId)로 상품 이름을 제목으로 쓴다.
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const meta = await shopShareMeta(prisma, (await params).slug);
  if (!meta) return {};
  // 공유 서비스는 절대 주소가 필요하다: 이 요청이 들어온 주소를 기준으로 한다(확인할 수 없으면 이미지 없이)
  const origin = siteOrigin(await headers());
  const description = meta.description ?? undefined;
  const image = { url: meta.image.url, width: meta.image.width, height: meta.image.height };
  return {
    metadataBase: origin ?? undefined,
    title: meta.title,
    description,
    openGraph: { type: "website", title: meta.title, description, images: origin ? [image] : undefined },
    twitter: { card: origin ? "summary_large_image" : "summary", title: meta.title, description, images: origin ? [image.url] : undefined },
  };
}

export default function ShopSlugLayout({ children }: { children: React.ReactNode }) {
  return children;
}
