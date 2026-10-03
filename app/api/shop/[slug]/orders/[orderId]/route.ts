import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../../lib/server/auth/session";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { getBuyerOrder } from "../../../../../../lib/server/orders/buyer";

// 구매자 본인 주문 상세(품목 스냅숏·금액·배송비·배송 상태·송장·본인 배송지). 다른 구매자·다른 쇼핑몰 주문은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; orderId: string }> }) {
  try {
    const { slug, orderId } = await params;
    const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
    if (!seller) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
    if (!session) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
    const order = await getBuyerOrder(prisma, { sellerId: seller.id, buyerMemberId: session.member.id }, orderId);
    if (!order) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json(order));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
