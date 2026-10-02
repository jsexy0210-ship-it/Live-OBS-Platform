import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { OPENED_NO_REFUND_CONSENT } from "../../../../../lib/server/orders/consent";

// 주문서·상품 상세에 보여 줄 결제 전 필수 동의 문구와 지금 버전. 화면은 이 version을 주문 요청의 consent.noticeVersion으로 보낸다.
// 로그인 없이 볼 수 있다(상품 상세에도 보여 줌). 없는 쇼핑몰은 404.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
    if (!seller) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ consents: [OPENED_NO_REFUND_CONSENT] });
  } catch (e) {
    return errorResponse(e);
  }
}
