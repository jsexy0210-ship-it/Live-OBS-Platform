import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../../lib/server/http/route";
import { bulkErrorBody, bulkFailureStatus, commitProductImport } from "../../../../../../../lib/server/shop-bulk-io/service";

// 일괄 등록 확정(PRODUCT_MANAGE): 미리보기를 통과한 상품만 등록한다(오류 상품은 건너뜀). 같은 작업을 다시 확정하면 처음 결과를 그대로 돌려준다.
// 응답 { jobId, status, createdCount, failedCount, failures: [{ row, name, message }], undoUntil }. 미리보기 1시간이 지나면 409 preview_expired.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await commitProductImport(prisma, ctx, (await params).jobId);
  if (!r.ok) return noStore(NextResponse.json(bulkErrorBody(r.reason), { status: bulkFailureStatus(r.reason) }));
  return noStore(NextResponse.json(r.value));
});
