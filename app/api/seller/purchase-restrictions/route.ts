import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listActiveRestrictions } from "../../../../lib/server/orders/overdue";

// 지금 주문이 막힌 구매자 목록(MEMBER_POINTS, 최근 200건). 잠금 중에도 볼 수 있다. ?buyerMemberId=<UUID>로 회원 한 명의 제한만 받을 수 있다(잘못된 값은 400).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const restrictions = await listActiveRestrictions(prisma, ctx, { buyerMemberId: new URL(req.url).searchParams.get("buyerMemberId") });
    if (!restrictions) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ restrictions });
  } catch (e) {
    return errorResponse(e);
  }
}
