import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerReceiptRequests } from "../../../../lib/server/receipts/service";

// 현금영수증·세금계산서 신청 목록(SA-024). ?status(PENDING·ON_HOLD·ISSUED·FAILED·CANCELLED)·cursor. 상태별 건수 counts. 영수증·세금계산서 권한(RECEIPT_TAX).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const q = new URL(req.url).searchParams;
    return noStore(NextResponse.json(await listSellerReceiptRequests(prisma, ctx, { status: q.get("status"), cursor: q.get("cursor") })));
  } catch (e) {
    return errorResponse(e);
  }
}
