import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { rejectReturn } from "../../../../../../lib/server/shop-returns/service";

// 거절(ORDER_SHIPPING), 신청 단계만. body { reason }: 구매자에게 보이는 사유(200자).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const r = await rejectReturn(prisma, ctx, id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return returnError(r.reason, "seller");
  return noStore(NextResponse.json({ request: r.request }));
});
