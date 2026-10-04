import { prisma } from "../../../../../lib/server/db";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { renderShopOgCard } from "../../../../../lib/server/shop/ogCard";
import { cardVersion } from "../../../../../lib/server/shop/sharePreview";

// 쇼핑몰 기본 공유 카드(1200×630 PNG, 쇼핑몰 이름). 로그인 없이 읽는다. 운영 중이 아니거나 잠긴 쇼핑몰은 404.
// 주소의 v(쇼핑몰 이름 해시)가 지금 이름과 같으면 오래 캐시하고, 다르거나 없으면 짧게 캐시한다(이름을 바꾸면 공유 메타가 새 주소를 준다).
// 같은 이름 그림은 메모리에 최근 것만 들고 있다(공개 주소라 매번 그리지 않게).
const CACHE_MAX = 200;
const rendered = new Map<string, Promise<Buffer>>();

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true } });
  if (!shop || !(await shopOpen(prisma, shop.id))) return new Response("not found", { status: 404 });
  const version = cardVersion(shop.shopName);
  let png = rendered.get(version);
  if (!png) {
    png = renderShopOgCard(shop.shopName);
    png.catch(() => rendered.delete(version));
    rendered.set(version, png);
    if (rendered.size > CACHE_MAX) rendered.delete(rendered.keys().next().value!);
  }
  const fresh = new URL(req.url).searchParams.get("v") === version;
  return new Response(new Uint8Array(await png), {
    headers: { "content-type": "image/png", "cache-control": fresh ? "public, max-age=86400, immutable" : "public, max-age=300" },
  });
}
