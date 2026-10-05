import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { youtubeResponse } from "../../../../../lib/server/youtube/http";
import { updateYoutubeSettings, youtubeSettings } from "../../../../../lib/server/youtube/settings";

// 유튜브 설정(SA-057): { chatDefaultEnabled }(채팅 수집 기본값, 기본 꺼짐, 새로 연결하는 방송에 적용).
// 조회 GET, 변경 PUT { chatDefaultEnabled: boolean }(로그 추적 youtube.settings.update). 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await youtubeSettings(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ chatDefaultEnabled: boolean }>(req);
  return youtubeResponse(await updateYoutubeSettings(prisma, ctx, body));
});
