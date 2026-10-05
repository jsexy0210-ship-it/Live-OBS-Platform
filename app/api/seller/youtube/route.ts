import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { youtubeApiKey } from "../../../../lib/server/youtube/client";
import { youtubeStatus } from "../../../../lib/server/youtube/service";

// 유튜브 연결 상태: { configured(서버 키 있음), channel, live(예정·진행 중 연결) }. 키가 없으면 configured:false(「연결 안 됨」).
// 대표자·「방송 진행」(BROADCAST_RUN) 직원만, 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await youtubeStatus(prisma, ctx, !!youtubeApiKey())));
  } catch (e) {
    return errorResponse(e);
  }
}
