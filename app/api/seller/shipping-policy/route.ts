import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { readShippingPolicy, updateShippingPolicy } from "../../../../lib/server/orders/ship";
import { COURIERS } from "../../../../lib/server/orders/shipping";

// 판매자 배송비 설정(SHOP_SETTINGS). 본문: { baseFee, freeOverAmount(null이면 무료 배송 없음), remoteSurcharge, remoteZipRanges: [[시작, 끝]] }.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json({ policy: await readShippingPolicy(prisma, ctx), couriers: COURIERS });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const r = await updateShippingPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
