import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson } from "../../../../../../lib/server/http/route";
import { SHIPPING_PREVIEW_MESSAGES, paymentErrorBody } from "../../../../../../lib/server/payments/messages";
import { previewShipping } from "../../../../../../lib/server/payments/shippingPreview";

// 주문서 배송비 미리보기(로그인 없이). 본문 { items: [{ optionId, quantity }], zipCode(5자리), address1 }.
// 응답 { itemsSubtotal, shippingFee, isRemote, total }(쿠폰 할인 전, 주문 생성과 같은 단가·배송비 규칙). 계산만 하고 아무것도 저장하지 않는다.
// 실패 { error, message(화면 문구) }: 400 invalid_items·invalid_address, 409 product_unavailable, 402 shop_unavailable, 404 not_found.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller) return noStore(NextResponse.json(paymentErrorBody("not_found"), { status: 404 }));
  const body = await readJson<{ items: unknown; zipCode: unknown; address1: unknown }>(req);
  const r = await previewShipping(prisma, { sellerId: seller.id, items: body.items, zipCode: body.zipCode, address1: body.address1 });
  if (!r.ok) {
    const status = r.reason === "shop_unavailable" ? 402 : r.reason === "product_unavailable" ? 409 : 400;
    return noStore(NextResponse.json({ error: r.reason, message: SHIPPING_PREVIEW_MESSAGES[r.reason] }, { status }));
  }
  return noStore(NextResponse.json(r.value));
});
