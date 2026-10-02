import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { getSubscriptionView } from "../../../../lib/server/billing/subscription";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 구독·결제 화면(대표자 전용). 체험하기가 끝나도 열린다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), new Date(), { allowUnpaid: true });
    return NextResponse.json(await getSubscriptionView(prisma, ctx));
  } catch (e) {
    return errorResponse(e);
  }
}
