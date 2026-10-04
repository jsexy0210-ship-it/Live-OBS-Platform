import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { setChatEnabled } from "../../../../../../lib/server/youtube/chat";
import { youtubeResponse } from "../../../../../../lib/server/youtube/http";

// 연결한 방송의 채팅 수집 켜기·끄기(PUT { enabled }). 응답 { chatEnabled, notice }: notice는 켤 때 화면에 보여 줄 보관 고지.
// 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ enabled: boolean }>(req);
  return youtubeResponse(await setChatEnabled(prisma, ctx, body.enabled));
});
