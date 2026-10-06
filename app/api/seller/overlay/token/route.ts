import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { requireSellerPermission } from "../../../../../lib/server/tenant/context";
import { mutation, sessionToken } from "../../../../../lib/server/http/route";
import { issueOverlayToken, reissueBlockedByLive } from "../../../../../lib/server/overlay/token";

// 오버레이 URL 토큰 발급·재발급(이전 토큰은 바로 폐기). 방송 중에는 재발급할 수 없다(409 live, 처음 발급은 가능). 응답의 token으로 /api/overlay/{token}/... 에 접속한다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  if (await reissueBlockedByLive(prisma, ctx.sellerId)) return NextResponse.json({ error: "live" }, { status: 409 });
  const token = await issueOverlayToken(prisma, ctx);
  return NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
});
