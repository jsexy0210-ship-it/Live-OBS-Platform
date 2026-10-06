import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../../lib/server/db";
import { isPopupEventType, recordPopupEvent } from "../../../../../../../../lib/server/shop-content/service";

// 구매자 화면의 팝업 노출·반응 집계(SA-065). 로그인 없이 보낸다. 본문 { type: "impression"|"close"|"click" }.
// 외부 서비스 없이 팝업·일(KST) 단위 DB 한 줄에 합산한다. 성공 204, 형식 오류 400, 운영 중이 아닌 쇼핑몰·없거나 숨긴 팝업 404.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; popupId: string }> }) {
  const { slug, popupId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const type = body && typeof body === "object" ? (body as { type?: unknown }).type : undefined;
  if (!isPopupEventType(type)) return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  if (!(await recordPopupEvent(prisma, slug, popupId, type))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
