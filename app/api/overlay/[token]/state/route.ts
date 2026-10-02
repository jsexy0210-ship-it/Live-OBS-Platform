import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { getOverlayState } from "../../../../../lib/server/overlay/state";
import { resolveOverlayToken } from "../../../../../lib/server/overlay/token";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const sellerId = await resolveOverlayToken(prisma, (await params).token);
    if (!sellerId) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await getOverlayState(prisma, sellerId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
