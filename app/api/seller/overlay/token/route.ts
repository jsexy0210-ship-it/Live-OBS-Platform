import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { assertSameOrigin, errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { issueOverlayToken } from "../../../../../lib/server/overlay/token";

// 오버레이 URL 토큰 발급·재발급(이전 토큰은 바로 폐기). 응답의 token으로 /api/overlay/{token}/... 에 접속한다.
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    const token = await issueOverlayToken(prisma, ctx);
    return NextResponse.json({ token }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
