import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../../lib/server/auth/session";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { quoteOrder } from "../../../../../../lib/server/orders/quote";
import { isOrderCouponFailure, ORDER_COUPON_MESSAGES } from "../../../../../../lib/server/shop-coupons/service";

// 주문서 견적(읽기 전용, 주문·쿠폰·적립금을 바꾸지 않음). 본문: { items: [{ optionId, quantity }], couponId?, rewardUseAmount?, zipCode?, address1? }.
// 응답 { itemsSubtotal, shippingFee, couponDiscount, coupon, rewardUse, rewardMax, rewardBalance, totalAmount, items }. 금액 기준은 서버 계산이며 주문 생성 때 다시 계산한다.
// 실패는 { error, message }(쿠폰 실패 409, 잠긴 쇼핑몰 402, 나머지 400).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await readJson<{ items: unknown; couponId: unknown; rewardUseAmount: unknown; zipCode: unknown; address1: unknown }>(req);
  const r = await quoteOrder(prisma, { sellerId: seller.id, buyerMemberId: session.member.id, items: body.items, couponId: body.couponId, rewardUseAmount: body.rewardUseAmount, zipCode: body.zipCode, address1: body.address1 });
  if (!r.ok) {
    if (isOrderCouponFailure(r.reason)) return noStore(NextResponse.json({ error: r.reason, message: ORDER_COUPON_MESSAGES[r.reason] }, { status: 409 }));
    return noStore(NextResponse.json(orderErrorBody(r.reason), { status: r.reason === "shop_unavailable" ? 402 : 400 }));
  }
  return noStore(NextResponse.json(r.value));
});
