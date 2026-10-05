import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listBulkJobs } from "../../../../../lib/server/shop-bulk-io/service";

// 일괄 등록 작업 목록(최근 30개, PRODUCT_MANAGE). 응답 { jobs: [{ id, status(PREVIEW·COMMITTING·COMMITTED·UNDONE), fileName, totalRows, productCount, createdCount, failedCount, errorTotal, keptCount, createdAt, committedAt, undoUntil, undoable }] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listBulkJobs(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
