import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { defaultYoutubeClient } from "../../../../../lib/server/youtube/client";
import { youtubeResponse } from "../../../../../lib/server/youtube/http";
import { connectLive, unlinkLive } from "../../../../../lib/server/youtube/service";

// 방송 영상 연결(PUT { url }: watch?v=·youtu.be·/live/ 주소) / 해제(DELETE, 이미 시작된 방송은 그대로).
// 유튜브가 진행 중으로 바뀌면 방송이 자동으로 시작되고, 끝나면 자동으로 끝난다(lib/server/youtube/sync.ts).
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ url: string }>(req);
  return youtubeResponse(await connectLive(prisma, ctx, defaultYoutubeClient(), body.url));
});

export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  return NextResponse.json(await unlinkLive(prisma, ctx));
});
