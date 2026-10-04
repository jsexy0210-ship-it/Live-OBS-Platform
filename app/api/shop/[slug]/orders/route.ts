import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { listBuyerOrders } from "../../../../../lib/server/orders/buyer";
import { createOrder, type CreateOrderFailure } from "../../../../../lib/server/orders/create";
import { orderErrorBody, purchaseRestrictedMessage } from "../../../../../lib/server/orders/messages";
import { isOrderCouponFailure, ORDER_COUPON_MESSAGES } from "../../../../../lib/server/shop-coupons/service";

// 구매자 본인 주문 목록(?cursor·limit, 응답 { orders, nextCursor }). 잠긴 쇼핑몰이어도 기존 주문 조회는 연다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
    if (!seller) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
    if (!session) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
    const q = new URL(req.url).searchParams;
    const r = await listBuyerOrders(prisma, { sellerId: seller.id, buyerMemberId: session.member.id }, { cursor: q.get("cursor") ?? undefined, limit: q.get("limit") ?? undefined });
    if (!r.ok) return noStore(NextResponse.json(orderErrorBody(r.reason), { status: 400 }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 구매자 주문 생성(결제 대기까지). 본문: { items: [{ optionId, quantity }], consent: { agreed: true, noticeVersion },
// shippingAddress: { recipientName, phone, zipCode, address1, address2?, memo? }, saveAddress?(기본 true: 배송지 목록에 저장) }. 실패 응답은 { error, message(화면 문구) }.
// couponId?(받은 쿠폰, 주문당 1장): 할인 금액은 서버가 계산한다.
// 금액은 서버가 계산하므로 본문의 금액 값은 쓰지 않는다. 잠긴 쇼핑몰은 402와 안내 문구(판매자 사정은 드러내지 않음).
const createOrderStatus = (reason: CreateOrderFailure) =>
  reason === "shop_unavailable" ? 402 : reason === "purchase_restricted" ? 403 : reason === "order_rate_limited" ? 429 : 400;

export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, status: true } });
  if (!seller) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await readJson<{ items: unknown; consent: { agreed?: unknown; noticeVersion?: unknown }; rewardUseAmount: unknown; shippingAddress: unknown; saveAddress: unknown }>(req);
  const r = await createOrder(prisma, {
    sellerId: seller.id,
    buyerMemberId: session.member.id,
    items: body.items,
    consent: body.consent && typeof body.consent === "object" ? body.consent : undefined,
    rewardUseAmount: body.rewardUseAmount,
    shippingAddress: body.shippingAddress,
    saveAddress: body.saveAddress,
    couponId: (body as { couponId?: unknown }).couponId,
    meta: requestMeta(req),
  });
  if (!r.ok) {
    // 구매 제한은 풀리는 시각(endsAt)과 KST 날짜 안내를 함께 준다
    if (r.reason === "purchase_restricted" && r.endsAt) {
      return NextResponse.json({ error: r.reason, message: purchaseRestrictedMessage(r.endsAt), endsAt: r.endsAt }, { status: 403 });
    }
    if (isOrderCouponFailure(r.reason)) return NextResponse.json({ error: r.reason, message: ORDER_COUPON_MESSAGES[r.reason] }, { status: 409 });
    return NextResponse.json(orderErrorBody(r.reason), { status: createOrderStatus(r.reason) });
  }
  return NextResponse.json(r);
});
