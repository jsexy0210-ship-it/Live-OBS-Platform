import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../../lib/server/http/route";
import { cartErrorBody, cartFailureStatus, checkoutSelection } from "../../../../../../lib/server/shop-cart/service";

// 주문서로 넘길 선택 항목. ?ids=줄id,줄id(최대 20). 응답 { items: [{ optionId, quantity }], lines, subtotal }.
// items는 주문 생성(POST /api/shop/[slug]/orders)의 items에 그대로 넣는다. 금액은 미리 보기(주문 때 서버가 다시 계산).
// 주문할 수 없는 줄이 있으면 409 { error: "checkout_unavailable", message, lines(문제 줄) }.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
    const r = await checkoutSelection(prisma, b.scope, ids);
    if (!r.ok) return noStore(NextResponse.json({ ...cartErrorBody(r.reason), ...("lines" in r ? { lines: r.lines } : {}) }, { status: cartFailureStatus(r.reason) }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
