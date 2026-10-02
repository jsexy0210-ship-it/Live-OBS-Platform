import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listActiveRestrictions } from "../../../../lib/server/orders/overdue";

// 지금 주문이 막힌 구매자 목록(MEMBER_POINTS). 잠금 중에도 볼 수 있다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
    return NextResponse.json({ restrictions: await listActiveRestrictions(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}
