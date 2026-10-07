import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listBulkJobs } from "../../../../../lib/server/shop-bulk-io/service";

// 일괄 등록 작업 목록(최근 30개, PRODUCT_MANAGE). ?all=true면 내보내기 이력(PRODUCT_EXPORT·ORDER_EXPORT·MEMBER_EXPORT)도 함께(처리 이력).
// 응답 { jobs: [{ id, kind, status(PREVIEW·COMMITTING·COMMITTED·UNDONE), fileName, totalRows, productCount, createdCount, failedCount, errorTotal, keptCount, reason, meta, createdAt, committedAt, undoUntil, undoable, actorName(처리한 직원 이름), actorIsOwner }] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listBulkJobs(prisma, ctx, { all: new URL(req.url).searchParams.get("all") === "true" })));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
