import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../../lib/server/http/route";
import { countCart } from "../../../../../../lib/server/shop-cart/service";

// 머리 장바구니 배지용 개수. 응답 { count }. 로그인 전이면 401 대신 { count: 0 }(배지만 숨기면 되게).
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res.status === 401 ? NextResponse.json({ count: 0 }) : b.res);
    return noStore(NextResponse.json({ count: await countCart(prisma, b.scope) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
