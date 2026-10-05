import { prisma } from "../../../../../../lib/server/db";
import { isFaviconSize, publicFavicon } from "../../../../../../lib/server/seller-settings/shopFavicon";

// 쇼핑몰 파비콘 PNG(32·180·512px). 로그인 없이 읽는다. 운영 중이 아니거나 잠긴 쇼핑몰, 파비콘·로고가 모두 없는 쇼핑몰은 404(화면이 ONQ 기본 아이콘을 쓴다).
// 주소의 v가 지금 버전과 같으면 1년 캐시, 아니면 짧게(올린 파일을 바꾸면 메타가 새 주소를 준다).
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; size: string }> }) {
  const { slug, size } = await ctx.params;
  const n = Number(size);
  if (!/^\d+$/.test(size) || !isFaviconSize(n)) return new Response("not found", { status: 404 });
  const r = await publicFavicon(prisma, slug, n);
  if (!r) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const fresh = new URL(req.url).searchParams.get("v") === r.version;
  const etag = `"${r.version}-${n}"`;
  const headers = { "content-type": "image/png", "x-content-type-options": "nosniff", etag, "cache-control": fresh ? "public, max-age=31536000, immutable" : "public, max-age=300" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(r.png), { headers });
}
