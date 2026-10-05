import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { chatStatus } from "../../../../../../lib/server/youtube/chat";

// 연결한 방송의 채팅 수집 상태(방송 대시보드 띠): { link: { id, videoId, broadcastSessionId, status } | null, state, reason, lastCollectedAt }.
// state·reason 값은 lib/server/youtube/chat.ts chatStateOf. 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await chatStatus(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}
