import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { shipExchange } from "../../../../../../lib/server/shop-returns/service";

// 교환 발송(ORDER_SHIPPING), 교환 신청의 회수 완료 단계만. body { courier, trackingNumber }. 교환 상품 재고를 뺀다(부족하면 409 insufficient_stock).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const r = await shipExchange(prisma, ctx, id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return returnError(r.reason, "seller");
  return noStore(NextResponse.json({ request: r.request }));
});
