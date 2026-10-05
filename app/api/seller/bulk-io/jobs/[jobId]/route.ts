import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { getBulkJob } from "../../../../../../lib/server/shop-bulk-io/service";

// 일괄 등록 작업 상세(PRODUCT_MANAGE): 목록 항목 + errors(행별 오류, 500개까지)·failures(확정 때 못 만든 상품). 다른 파트너스의 작업은 404.
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await getBulkJob(prisma, ctx, (await params).jobId)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
