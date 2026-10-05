import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { readOrderPolicy, updateOrderPolicy } from "../../../../lib/server/orders/overdue";

// 판매자 주문 정책(SHOP_SETTINGS). 본문: { autoCancelEnabled, paymentDueHours(1~720), unpaidRestrictionEnabled,
// paidCancelRestrictionEnabled?, restockOnCancel?, autoDeliverEnabled?, autoDeliverDays?(1~30), autoConfirmEnabled?, autoConfirmDays?(1~30),
// dueReminderEnabled?(입금 기한 알림, 기본 켜짐), autoTrackingEnabled?(배송 자동 조회, 기본 꺼짐·켜면 건당 발송·이용 충전금 차감) }. ?는 빼면 지금 값 유지.
// 바꾼 입금 기한은 다음 주문부터.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ policy: await readOrderPolicy(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateOrderPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
