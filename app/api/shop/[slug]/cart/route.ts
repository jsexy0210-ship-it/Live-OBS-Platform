import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson } from "../../../../../lib/server/http/route";
import { addToCart, cartErrorBody, cartFailureStatus, listCart, removeCartItems } from "../../../../../lib/server/shop-cart/service";

// 구매자 장바구니(SH-004). 응답 { items: [{ id, productId, optionId, productName, optionName, quantity, unitPrice, listUnitPrice, lineTotal, stock, status }], count, subtotal }.
// status: available · not_enough_stock · sold_out · unavailable. 잠긴 쇼핑몰이어도 목록·삭제는 연다. 개인 정보라 캐시하지 않는다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    return noStore(NextResponse.json(await listCart(prisma, b.scope)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 담기. 본문: { optionId, quantity?(기본 1) }. 같은 옵션이면 수량을 더한다. 응답 { item: { id, quantity }, count }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await addToCart(prisma, b.scope, await readJson(req));
  if (!r.ok) return noStore(NextResponse.json(cartErrorBody(r.reason), { status: cartFailureStatus(r.reason) }));
  return noStore(NextResponse.json({ item: { id: r.value.id, quantity: r.value.quantity }, count: r.value.count }, { status: 201 }));
});

// 선택 삭제. 본문: { itemIds: [] }. 응답 { removed, count }.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await removeCartItems(prisma, b.scope, (await readJson<{ itemIds: unknown }>(req)).itemIds);
  if (!r.ok) return noStore(NextResponse.json(cartErrorBody(r.reason), { status: cartFailureStatus(r.reason) }));
  return noStore(NextResponse.json(r.value));
});
