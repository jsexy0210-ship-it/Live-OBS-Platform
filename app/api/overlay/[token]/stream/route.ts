import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { resolveOverlayToken } from "../../../../../lib/server/overlay/token";
import { liveHub } from "../../../../../lib/server/realtime/hub";
import { sseResponse } from "../../../../../lib/server/realtime/sse";

export const dynamic = "force-dynamic";

// OBS 브라우저 소스용 실시간 채널(SSE). 토큰으로 판매자를 정하고, 다른 판매자 채널은 구독할 수 없다.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const sellerId = await resolveOverlayToken(prisma, (await params).token);
    if (!sellerId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const s = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { liveVersion: true } });
    return sseResponse(liveHub(), sellerId, s.liveVersion, req.signal);
  } catch (e) {
    return errorResponse(e);
  }
}
