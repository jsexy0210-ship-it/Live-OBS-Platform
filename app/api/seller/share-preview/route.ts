import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { SHARE_PREVIEW_MESSAGES, readSharePreview, updateSharePreview } from "../../../../lib/server/shop/sharePreview";

// 쇼핑몰 공유 미리보기 제목·설명(SA-060). 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 권한 직원만 바꾼다(그 밖 403).
// PUT 본문: { title: string | null, description: string | null }(빈 값·null이면 기본값: 제목은 쇼핑몰 이름, 설명은 없음).
// 제목 60자·설명 160자를 넘거나 보이지 않는 문자가 있으면 400 invalid_share_preview.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ preview: await readSharePreview(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateSharePreview(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SHARE_PREVIEW_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ preview: r.preview });
});
