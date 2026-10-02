import { hashToken } from "../../../../lib/server/auth/token";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { getLiveVersion } from "../../../../lib/server/queue/read";
import { liveHub } from "../../../../lib/server/realtime/hub";
import { openSse } from "../../../../lib/server/realtime/sse";
import { requireSellerRead } from "../../../../lib/server/tenant/context";

export const dynamic = "force-dynamic";

// 방송 대시보드 실시간 채널(SSE). version이 바뀌면 화면이 /api/seller/queue를 다시 받는다.
// 연결 중에도 핑마다 세션·판매자 상태·방송 진행 권한(BROADCAST_RUN)을 다시 확인하고, 무효면 닫는다.
export async function GET(req: Request) {
  try {
    const token = sessionToken(req, "seller");
    const ctx = await requireSeller(prisma, token);
    requireSellerRead(ctx, "BROADCAST_RUN");
    return await openSse(liveHub(), {
      sellerId: ctx.sellerId,
      key: `seller:${hashToken(token!)}`,
      readVersion: () => getLiveVersion(prisma, ctx),
      revalidate: async () => {
        const now = await requireSeller(prisma, token);
        requireSellerRead(now, "BROADCAST_RUN");
        return now.sellerId === ctx.sellerId;
      },
      signal: req.signal,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
