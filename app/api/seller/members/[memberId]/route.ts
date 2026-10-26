import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { getSellerMember, getSellerMemberSummary } from "../../../../../lib/server/buyers/sellerMembers";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";

// 파트너스 회원 상세(주문 수·누적 결제·적립금 잔액·등급). MEMBER_POINTS 권한. 탈퇴·다른 쇼핑몰 회원은 404.
export async function GET(req: Request, { params }: { params: Promise<{ memberId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    if (new URL(req.url).searchParams.get("summary") === "1") {
      const member = await getSellerMemberSummary(prisma, ctx, (await params).memberId);
      return NextResponse.json({ member }, { headers: { "cache-control": "no-store" } });
    }
    const member = await getSellerMember(prisma, ctx, (await params).memberId);
    return NextResponse.json({ member }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
