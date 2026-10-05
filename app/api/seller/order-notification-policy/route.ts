import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { readOrderNotificationPolicy, updateOrderNotificationPolicy } from "../../../../lib/server/seller-settings/orderNotificationPolicy";

// 주문자 메일 켜기·끄기(SA-080, SHOP_SETTINGS). 응답·본문: { orderComplete, shipped, delivered, cancelRefund } boolean. PUT은 빼면 지금 값 유지.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ policy: await readOrderNotificationPolicy(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateOrderNotificationPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
