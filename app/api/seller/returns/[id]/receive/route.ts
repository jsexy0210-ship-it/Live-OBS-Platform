import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { receiveReturn } from "../../../../../../lib/server/shop-returns/service";

// 회수 완료(ORDER_SHIPPING). body { restock?: boolean }: true면 이 신청 품목의 재고를 되돌린다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const r = await receiveReturn(prisma, ctx, id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return returnError(r.reason, "seller");
  return noStore(NextResponse.json({ request: r.request }));
});
