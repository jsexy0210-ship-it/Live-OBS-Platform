import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { getLiveVersion } from "../../../../lib/server/queue/read";
import { liveHub } from "../../../../lib/server/realtime/hub";
import { sseResponse } from "../../../../lib/server/realtime/sse";

export const dynamic = "force-dynamic";

// 방송 대시보드 실시간 채널(SSE). version이 바뀌면 화면이 /api/seller/queue를 다시 받는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    const version = await getLiveVersion(prisma, ctx);
    return sseResponse(liveHub(), ctx.sellerId, version, req.signal);
  } catch (e) {
    return errorResponse(e);
  }
}
