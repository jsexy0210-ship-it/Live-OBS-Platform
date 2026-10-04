import { prisma } from "../../../../../lib/server/db";
import { isBrandingTarget, readImage } from "../../../../../lib/server/branding/store";

// 관리자 화면 파비콘(로그인 화면에서도 쓰므로 로그인 없이 읽음). 올린 파비콘이 없으면 404(앱 기본 아이콘을 쓴다).
// 주소의 v가 지금 해시와 같으면 1년 캐시, 아니면 짧게. 형식은 저장 때 바이트로 확인한 값만 쓴다.
export async function GET(req: Request, ctx: { params: Promise<{ target: string }> }) {
  const { target } = await ctx.params;
  if (!isBrandingTarget(target)) return new Response("not found", { status: 404 });
  const image = await readImage(prisma, target, "favicon");
  if (!image) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const fresh = new URL(req.url).searchParams.get("v") === image.hash;
  return new Response(new Uint8Array(image.data), {
    headers: {
      "content-type": image.type,
      "cache-control": fresh ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      etag: `"${image.hash}"`,
    },
  });
}
