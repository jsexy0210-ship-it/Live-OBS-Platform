import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore } from "../../../../../../lib/server/http/route";
import { removeWish, wishErrorBody, wishFailureStatus } from "../../../../../../lib/server/shop-wish/service";

// 찜 빼기(상품 id). 응답 { removed, count }. 찜하지 않은 상품이면 404.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; productId: string }> }) => {
  const { slug, productId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await removeWish(prisma, b.scope, productId);
  if (!r.ok) return noStore(NextResponse.json(wishErrorBody(r.reason), { status: wishFailureStatus(r.reason) }));
  if (!r.value.removed) return noStore(NextResponse.json(wishErrorBody("wish_item_not_found"), { status: 404 }));
  return noStore(NextResponse.json(r.value));
});
