import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { acceptReturn } from "../../../../../../lib/server/shop-returns/service";

// 접수(ORDER_SHIPPING). body { fault?: "BUYER"|"SELLER" }: 사유 주체. 사유가 「기타」면 꼭 보낸다(400 fault_required).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const r = await acceptReturn(prisma, ctx, id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return returnError(r.reason, "seller");
  return noStore(NextResponse.json({ request: r.request }));
});
