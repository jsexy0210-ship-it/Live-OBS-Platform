import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { getPublicLayout, parseAspect } from "../../../../../lib/server/overlay/layout";
import { resolveOverlayToken } from "../../../../../lib/server/overlay/token";

export const dynamic = "force-dynamic";

// 오버레이 화면이 그릴 레이아웃(?aspect=9x16|16x9, 기본 9x16). 토큰이 폐기·잠김이면 404(state와 같음). 위젯과 version만 준다.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const sellerId = await resolveOverlayToken(prisma, (await params).token);
    if (!sellerId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const raw = new URL(req.url).searchParams.get("aspect");
    const aspect = raw === null ? "9x16" : parseAspect(raw);
    if (!aspect) return NextResponse.json({ error: "invalid_aspect" }, { status: 400 });
    // 지금 LIVE 방송이 있고 아직 레이아웃이 기록되지 않았으면 처음 요청한 레이아웃을 방송 이력(SA-054)에 남긴다(실패해도 오버레이 응답을 막지 않음)
    await prisma.broadcastSession.updateMany({ where: { sellerId, status: "LIVE", layoutAspect: null }, data: { layoutAspect: aspect } }).catch(() => undefined);
    return NextResponse.json(await getPublicLayout(prisma, sellerId, aspect), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
