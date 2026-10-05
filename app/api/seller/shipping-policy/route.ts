import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { readShippingPolicy, updateShippingPolicy } from "../../../../lib/server/orders/ship";
import { AVAILABLE_RECEIVE_METHODS, COURIERS, MAX_DISPATCH_DEADLINE_DAYS, PLANNED_RECEIVE_METHODS } from "../../../../lib/server/orders/shipping";

// 판매자 배송비 설정(SHOP_SETTINGS). 본문: { baseFee, freeOverAmount(null이면 무료 배송 없음), remoteSurcharge, remoteZipRanges: [[시작, 끝]], returnFee(반품 배송비 편도), exchangeFee(교환 배송비 왕복) }.
// returnFee·exchangeFee는 빼고 보내면 지금 값을 그대로 둔다.
// SA-061: receiveMethods(받는 방법, 지금은 ["IMMEDIATE"]만 가능, 1개 이상), dispatchDeadlineDays(발송 기한 1~30일), defaultCourier(기본 택배사 코드 또는 null)도 빼면 지금 값을 둔다.
// GET 응답의 receiveMethodOptions·maxDispatchDeadlineDays로 화면이 고를 수 있는 값을 안다(planned는 아직 켤 수 없음).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ policy: await readShippingPolicy(prisma, ctx), couriers: COURIERS, receiveMethodOptions: { available: AVAILABLE_RECEIVE_METHODS, planned: PLANNED_RECEIVE_METHODS }, maxDispatchDeadlineDays: MAX_DISPATCH_DEADLINE_DAYS });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateShippingPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
