import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../../lib/server/http/route";
import { bulkErrorBody, bulkFailureStatus, undoProductImport } from "../../../../../../../lib/server/shop-bulk-io/service";

// 일괄 등록 되돌리기(PRODUCT_MANAGE): 확정 뒤 24시간 안에 등록한 상품을 삭제 처리한다. 주문이 이미 있는 상품은 남긴다.
// 응답 { removedCount, keptCount, kept: [{ productId, name }] }. 한 번만 되돌릴 수 있고, 24시간이 지나면 409 undo_expired.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await undoProductImport(prisma, ctx, (await params).jobId);
  if (!r.ok) return noStore(NextResponse.json(bulkErrorBody(r.reason), { status: bulkFailureStatus(r.reason) }));
  return noStore(NextResponse.json(r.value));
});
