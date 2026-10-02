import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { createOrder } from "../../../../../lib/server/orders/create";

// 구매자 주문 생성(결제 대기까지). 본문: { items: [{ optionId, quantity }], consent: { agreed: true, noticeVersion } }.
// 금액은 서버가 계산하므로 본문의 금액 값은 쓰지 않는다. 잠긴 쇼핑몰은 402와 안내 문구(판매자 사정은 드러내지 않음).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, status: true } });
  if (!seller) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await readJson<{ items: unknown; consent: { agreed?: unknown; noticeVersion?: unknown }; rewardUseAmount: unknown }>(req);
  const r = await createOrder(prisma, {
    sellerId: seller.id,
    buyerMemberId: session.member.id,
    items: body.items,
    consent: body.consent && typeof body.consent === "object" ? body.consent : undefined,
    rewardUseAmount: body.rewardUseAmount,
    meta: requestMeta(req),
  });
  if (!r.ok) {
    if (r.reason === "shop_unavailable") {
      return NextResponse.json({ error: r.reason, message: "지금은 쇼핑몰을 이용할 수 없어요" }, { status: 402 });
    }
    return NextResponse.json({ error: r.reason }, { status: 400 });
  }
  return NextResponse.json(r);
});
