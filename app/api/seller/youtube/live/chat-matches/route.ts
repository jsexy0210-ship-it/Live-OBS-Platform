import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { chatMatches } from "../../../../../../lib/server/youtube/chat";
import { youtubeResponse } from "../../../../../../lib/server/youtube/http";

// 방송 주문 닉네임과 유튜브 채팅 표시 이름 매칭(표시용, 주문은 바꾸지 않음). ?broadcastSessionId=로 방송 지정(없으면 가장 최근 유튜브 방송).
// 응답 { broadcast, chatEnabled, summary: { orders, matched, chatAuthors }, orders: [{ orderId, orderNo, status, nickname, orderedAt, matched, lastChatAt }] }.
// 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const id = new URL(req.url).searchParams.get("broadcastSessionId");
    return noStore(youtubeResponse(await chatMatches(prisma, ctx, id)));
  } catch (e) {
    return errorResponse(e);
  }
}
