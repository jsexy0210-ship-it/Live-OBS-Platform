import { prisma } from "../../../../../../lib/server/db";
import { imageResponse } from "../../../../../../lib/server/shop-content/image";
import { publicLogo } from "../../../../../../lib/server/shop-content/logo";

// 구매자 쇼핑몰 머리의 로고. 로그인 없이 읽는다. 로고가 없거나 운영 중이 아닌·스토어 운영 권한이 없는 쇼핑몰은 404
// (화면은 쇼핑몰 이름 첫 글자를 보인다). 머리는 버전 없는 주소를 쓰므로 매번 ETag로 다시 확인해(no-cache, 바뀌지 않았으면 304)
// 로고를 바꾸거나 지우면 바로 반영된다. 주소에 지금 해시 v가 있으면 1년 immutable.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const row = await publicLogo(prisma, slug);
  if (!row) return new Response("not found", { status: 404, headers: { "x-content-type-options": "nosniff", "cache-control": "no-cache" } });
  const res = imageResponse(req, row, "public");
  if (!new URL(req.url).searchParams.has("v")) res.headers.set("cache-control", "public, no-cache");
  return res;
}
