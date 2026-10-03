import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { readEarnTiming, updateEarnTiming } from "../../../../lib/server/rewards/policy";

// 적립금 지급 시점(MEMBER_POINTS). 본문: { earnTiming: "ON_PAYMENT"(결제 즉시) | "ON_DELIVERY"(배송 완료 후, 기본) }.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json({ policy: await readEarnTiming(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const r = await updateEarnTiming(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  return NextResponse.json({ policy: { earnTiming: r.earnTiming } });
});
