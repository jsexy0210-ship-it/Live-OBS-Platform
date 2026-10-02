import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { sellerAccessFor } from "../../../../lib/server/billing/subscription";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

export async function GET(req: Request) {
  try {
    // 체험하기가 끝나도 열린다(화면이 구독·결제로 안내하려면 이용 상태가 필요).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
    const access = await sellerAccessFor(prisma, ctx.sellerId);
    return NextResponse.json({ sellerId: ctx.sellerId, userId: ctx.actorId, isOwner: ctx.isOwner, permissions: ctx.permissions, access });
  } catch (e) {
    return errorResponse(e);
  }
}
