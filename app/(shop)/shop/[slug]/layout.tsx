import type { Metadata } from "next";
import { headers } from "next/headers";
import { DEFAULT_FAVICON } from "../../../../lib/server/branding/service";
import { requestOrigin } from "../../../../lib/server/branding/siteUrl";
import { prisma } from "../../../../lib/server/db";
import { shopShareMeta } from "../../../../lib/server/shop/sharePreview";

type Params = { params: Promise<{ slug: string }> };

// 쇼핑몰 파비콘 업로드 전까지는 ONQ 기본 아이콘(브랜딩과 같은 파일, lib/server/branding/service.ts DEFAULT_FAVICON)
const ICONS: Metadata["icons"] = {
  icon: [{ url: DEFAULT_FAVICON.url, type: DEFAULT_FAVICON.type, sizes: "32x32" }],
  shortcut: [{ url: DEFAULT_FAVICON.url, type: DEFAULT_FAVICON.type }],
  apple: [{ url: DEFAULT_FAVICON.appleUrl }],
};

// 쇼핑몰 공개 페이지 공통 공유 미리보기(SA-060): 운영 중인 쇼핑몰이면 og:title·og:description·og:image를 쇼핑몰 설정(제목·설명)과
// 서버가 그리는 기본 카드(/api/shop/{slug}/og.png)로 채운다. 잠겼거나 없는 쇼핑몰은 공유 정보 없이 기본 아이콘만 둔다.
// 화면마다 정한 title(예: 회원가입 · 쇼핑몰 이름)은 그 화면 값이 우선한다.
// 상품 상세 화면이 생기면 그 화면에서 shopShareMeta(slug, productId)로 상품 이름을 제목으로 쓴다.
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const meta = await shopShareMeta(prisma, (await params).slug);
  if (!meta) return { icons: ICONS };
  // 공유 서비스는 절대 주소가 필요하다: 요청 주소를 기준으로 한다(신뢰 프록시 규칙·형식 검사는 requestOrigin, 확인할 수 없으면 이미지 없이)
  const origin = requestOrigin(await headers());
  const description = meta.description ?? undefined;
  const image = { url: meta.image.url, width: meta.image.width, height: meta.image.height };
  return {
    metadataBase: origin ?? undefined,
    icons: ICONS,
    title: meta.title,
    description,
    openGraph: { type: "website", title: meta.title, description, images: origin ? [image] : undefined },
    twitter: { card: origin ? "summary_large_image" : "summary", title: meta.title, description, images: origin ? [image.url] : undefined },
  };
}

export default function ShopSlugLayout({ children }: { children: React.ReactNode }) {
  return children;
}
