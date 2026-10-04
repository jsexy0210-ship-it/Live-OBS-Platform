import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { listSellerMessageLedger } from "../../../../../lib/server/messaging/settings";

// 충전·차감 사용 내역(대표자 전용). ?cursor&limit(기본 50, 최대 200), 최근 순.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const q = new URL(req.url).searchParams;
    const r = await listSellerMessageLedger(prisma, ctx, { cursor: q.get("cursor"), limit: q.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    return NextResponse.json({ entries: r.entries, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
