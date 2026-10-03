import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { readOrderPolicy, updateOrderPolicy } from "../../../../lib/server/orders/overdue";

// 판매자 주문 정책(SHOP_SETTINGS). 본문: { paymentDueHours(1~168), unpaidRestrictionEnabled }. 바꾼 입금 기한은 다음 주문부터.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json({ policy: await readOrderPolicy(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const r = await updateOrderPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
