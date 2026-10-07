import { renderBrandingCard } from "../../../../../lib/server/branding/card";
import { isBrandingTarget } from "../../../../../lib/server/branding/store";
import { BRANDING_TITLE_MAX } from "../../../../../lib/server/branding/service";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { cleanText } from "../../../../../lib/server/text/clean";

// 저장 전 미리보기: ?title=로 그린 공유 카드(1200×630 PNG). 그리기 비용이 있어 바꿀 수 있는 최고관리자만.
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
    const url = new URL(req.url);
    const targetParam = url.searchParams.get("target");
    const target = targetParam === null ? "admin" : isBrandingTarget(targetParam) ? targetParam : null;
    if (!target) return noStore(Response.json({ error: "invalid_branding_target" }, { status: 400 }));
    const title = cleanText(url.searchParams.get("title"), BRANDING_TITLE_MAX, "name");
    if (!title) return noStore(Response.json({ error: "invalid_branding_text" }, { status: 400 }));
    const png = await renderBrandingCard(target, title, url.host);
    return noStore(new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "x-content-type-options": "nosniff" } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
