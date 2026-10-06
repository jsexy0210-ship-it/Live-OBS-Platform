import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getInvoice } from "../../../../../lib/server/invoices/service";

// 송장 추적 상세(SA-028 「추적 상세」, ORDER_SHIPPING): 송장·묶인 주문·events(최신순: 시각·종류·처리 SELLER/CARRIER·비고). 받는 분 정보는 개인정보 권한이 있을 때만.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const r = await getInvoice(prisma, ctx, (await params).id);
    if (!r) return noStore(NextResponse.json({ error: "not_found", message: "송장을 찾을 수 없습니다" }, { status: 404 }));
    return noStore(NextResponse.json({ invoice: r }));
  } catch (e) {
    return errorResponse(e);
  }
}
