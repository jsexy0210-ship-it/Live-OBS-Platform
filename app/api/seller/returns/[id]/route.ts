import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerReturn } from "../../../../../lib/server/shop-returns/service";

// 교환·반품 상세. 반품이 접수·회수 완료 단계면 환불 미리보기(refundPreview)와 환불 화면이 보낼 버전(queueVersion)도 준다.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const { id } = await params;
    const r = await getSellerReturn(prisma, ctx, id);
    if (!r) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json(r));
  } catch (e) {
    return errorResponse(e);
  }
}
