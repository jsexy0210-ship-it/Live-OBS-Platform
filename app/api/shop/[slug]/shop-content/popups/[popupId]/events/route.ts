import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../../lib/server/db";
import { clientIp } from "../../../../../../../../lib/server/http/route";
import { allowPopupEvent } from "../../../../../../../../lib/server/shop-content/popupEventLimit";
import { isPopupEventType, isUuid, recordPopupEvent } from "../../../../../../../../lib/server/shop-content/service";

// 구매자 화면의 팝업 노출·반응 집계(SA-065). 로그인 없이 보낸다. 본문 { type: "impression"|"close"|"click" }.
// 외부 서비스 없이 팝업·일(KST) 단위 DB 한 줄에 합산한다. 성공 204, 형식 오류 400, 운영 중이 아닌 쇼핑몰·없거나 숨긴 팝업 404,
// 같은 접속(IP)이 같은 팝업에 같은 종류를 1시간에 60번 넘게 보내면 429 too_many_requests(세지 않음).
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; popupId: string }> }) {
  const { slug, popupId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const type = body && typeof body === "object" ? (body as { type?: unknown }).type : undefined;
  if (!isPopupEventType(type)) return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  if (!isUuid(popupId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!allowPopupEvent(popupId, type, clientIp(req))) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  if (!(await recordPopupEvent(prisma, slug, popupId, type))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
