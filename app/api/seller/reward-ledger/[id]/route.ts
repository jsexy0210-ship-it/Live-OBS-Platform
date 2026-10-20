import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getRewardLedgerEntry } from "../../../../../lib/server/seller-settings/rewardLedger";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const entry = await getRewardLedgerEntry(prisma, ctx, (await params).id);
    return noStore(entry ? NextResponse.json({ entry }) : NextResponse.json({ error: "not_found" }, { status: 404 }));
  } catch (e) { return errorResponse(e); }
}
