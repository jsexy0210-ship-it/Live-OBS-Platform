import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, sessionToken } from "../../../../../lib/server/http/route";
import { purgeSellerChats } from "../../../../../lib/server/youtube/settings";

// 보관 채팅 지금 삭제(SA-057): 이 쇼핑몰이 보관한 유튜브 채팅을 모두 지운다. 대표자만(직원 403), 로그 추적 youtube.chat.purge. 응답 { deleted }.
// 플랜 기능 OVERLAY.
export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  return NextResponse.json(await purgeSellerChats(prisma, ctx));
});
