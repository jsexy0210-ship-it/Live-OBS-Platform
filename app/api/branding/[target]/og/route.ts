import { renderBrandingCard } from "../../../../../lib/server/branding/card";
import { ogImageSource } from "../../../../../lib/server/branding/service";
import { isBrandingTarget } from "../../../../../lib/server/branding/store";
import { prisma } from "../../../../../lib/server/db";

// 관리자 화면 공유 카드 이미지(1200×630). 올린 이미지가 있으면 그것, 없으면 제목으로 그린 카드. 로그인 없이 읽는다(공유 서비스가 가져감).
// 주소의 v(이미지 해시 또는 카드 제목 해시)가 지금 값과 같으면 1년 캐시, 아니면 짧게.
export async function GET(req: Request, ctx: { params: Promise<{ target: string }> }) {
  const { target } = await ctx.params;
  if (!isBrandingTarget(target)) return new Response("not found", { status: 404 });
  const src = await ogImageSource(prisma, target);
  const [body, type, version] =
    src.kind === "uploaded" ? [src.image.data, src.image.type, src.image.hash] : [await renderBrandingCard(target, src.title, new URL(req.url).host), "image/png", src.version];
  const fresh = new URL(req.url).searchParams.get("v") === version;
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": type,
      "cache-control": fresh ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      etag: `"${version}"`,
    },
  });
}
