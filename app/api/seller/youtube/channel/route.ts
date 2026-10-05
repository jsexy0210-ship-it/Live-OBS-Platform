import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { defaultYoutubeClient } from "../../../../../lib/server/youtube/client";
import { youtubeResponse } from "../../../../../lib/server/youtube/http";
import { connectChannel, disconnectChannel } from "../../../../../lib/server/youtube/service";

// 채널 연결(PUT { url }: @핸들·채널 주소·UC… ID) / 해제(DELETE). 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ url: string }>(req);
  return youtubeResponse(await connectChannel(prisma, ctx, defaultYoutubeClient(), body.url));
});

export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  return NextResponse.json(await disconnectChannel(prisma, ctx));
});
