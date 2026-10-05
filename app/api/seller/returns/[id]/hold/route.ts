import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { holdExchange } from "../../../../../../lib/server/shop-returns/service";

// 교환 재고 없음: 재입고 뒤 발송으로 보류(ORDER_SHIPPING, 교환만).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const r = await holdExchange(prisma, ctx, id);
  if (!r.ok) return returnError(r.reason, "seller");
  return noStore(NextResponse.json({ request: r.request }));
});
