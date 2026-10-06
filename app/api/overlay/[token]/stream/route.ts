import { NextResponse } from "next/server";
import { hashToken } from "../../../../../lib/server/auth/token";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { resolveOverlayToken } from "../../../../../lib/server/overlay/token";
import { liveHub } from "../../../../../lib/server/realtime/hub";
import { DISCONNECT_GRACE_MS, recordOverlayConnect, recordOverlayDisconnect } from "../../../../../lib/server/broadcast/events";
import { openSse, openStreamCount } from "../../../../../lib/server/realtime/sse";

export const dynamic = "force-dynamic";

// OBS 브라우저 소스용 실시간 채널(SSE). 토큰으로 판매자를 정하고, 다른 판매자 채널은 구독할 수 없다.
// 연결 중에도 핑마다 토큰(재발급으로 폐기됐는지)과 판매자 상태를 다시 확인하고, 무효면 닫는다.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const token = (await params).token;
    const sellerId = await resolveOverlayToken(prisma, token);
    if (!sellerId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const key = `overlay:${hashToken(token)}`;
    const res = await openSse(liveHub(), {
      sellerId,
      key,
      readVersion: async () =>
        (await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { liveVersion: true } })).liveVersion,
      revalidate: async () => (await resolveOverlayToken(prisma, token)) === sellerId,
      signal: req.signal,
    });
    // 방송 화면·연결 로그(SA-055): 연결을 남기고, 마지막 연결이 닫힌 뒤 잠시 지나도 다시 안 붙으면 끊김으로 남긴다
    if (res.ok) {
      void recordOverlayConnect(prisma, sellerId);
      req.signal.addEventListener("abort", () => {
        const at = new Date();
        setTimeout(() => {
          if (openStreamCount(key) === 0) void recordOverlayDisconnect(prisma, sellerId, at);
        }, DISCONNECT_GRACE_MS).unref?.();
      });
    }
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
