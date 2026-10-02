import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { resolveOverlayToken } from "../../../../../lib/server/overlay/token";

export const dynamic = "force-dynamic";

// 오버레이의 15초 주기 확인용.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const sellerId = await resolveOverlayToken(prisma, (await params).token);
    if (!sellerId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const s = await prisma.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { liveVersion: true } });
    return NextResponse.json({ version: s.liveVersion }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
