import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { getSellerInquiry } from "../../../../../lib/server/buyer-inquiries/service";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 구매자 문의 상세(SA-047). 응답 { inquiry, canEdit }. 다른 쇼핑몰 문의는 404.
export async function GET(req: Request, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await getSellerInquiry(prisma, ctx, (await params).inquiryId, "/api/seller/inquiries/images")));
  } catch (e) {
    return errorResponse(e);
  }
}
