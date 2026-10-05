import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson } from "../../../../../../lib/server/http/route";
import { cartErrorBody, cartFailureStatus, removeCartItems, updateCartItem } from "../../../../../../lib/server/shop-cart/service";

type Params = { params: Promise<{ slug: string; itemId: string }> };

// 수량 바꾸기. 본문: { quantity }(1~99). 응답 { item: { id, quantity } }.
export const PATCH = mutation(async (req: Request, { params }: Params) => {
  const { slug, itemId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await updateCartItem(prisma, b.scope, itemId, await readJson(req));
  if (!r.ok) return noStore(NextResponse.json(cartErrorBody(r.reason), { status: cartFailureStatus(r.reason) }));
  return noStore(NextResponse.json({ item: r.value }));
});

// 한 줄 지우기. 응답 { removed, count }. 없거나 남의 줄이면 404.
export const DELETE = mutation(async (req: Request, { params }: Params) => {
  const { slug, itemId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await removeCartItems(prisma, b.scope, [itemId]);
  if (!r.ok || r.value.removed === 0) return noStore(NextResponse.json(cartErrorBody("cart_item_not_found"), { status: 404 }));
  return noStore(NextResponse.json(r.value));
});
