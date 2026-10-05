import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, sessionToken } from "../../../../../../lib/server/http/route";
import { defaultYoutubeClient } from "../../../../../../lib/server/youtube/client";
import { youtubeResponse } from "../../../../../../lib/server/youtube/http";
import { findChannelLive } from "../../../../../../lib/server/youtube/service";

// 연결한 채널에서 예정·진행 중 방송을 찾아 연결(「지금 방송 찾기」). 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  return youtubeResponse(await findChannelLive(prisma, ctx, defaultYoutubeClient()));
});
