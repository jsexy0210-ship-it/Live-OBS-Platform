import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson } from "../../../../../lib/server/http/route";
import { addWish, listWish, wishedProductIds, wishErrorBody, wishFailureStatus } from "../../../../../lib/server/shop-wish/service";

// 구매자 찜 목록(SH-034). 응답 { items: [{ productId, name, price(지금 판매가), listPrice(정가), status(on_sale·sold_out·unavailable), wishedAt }], count }.
// ?ids=1 이면 찜한 상품 id만 { productIds }(하트 표시용, ?productIds=a,b로 좁힘). 잠긴 쇼핑몰이어도 목록·빼기는 연다. 개인 정보라 캐시하지 않는다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    const q = new URL(req.url).searchParams;
    if (q.get("ids") === "1") {
      const filter = q.get("productIds");
      return noStore(NextResponse.json({ productIds: await wishedProductIds(prisma, b.scope, filter === null ? undefined : filter.split(",").slice(0, 100)) }));
    }
    return noStore(NextResponse.json(await listWish(prisma, b.scope)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 찜하기. 본문: { productId }. 새로 찜하면 201, 이미 찜했으면 200. 응답 { productId, count }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const { productId } = await readJson<{ productId: unknown }>(req);
  const r = await addWish(prisma, b.scope, productId);
  if (!r.ok) return noStore(NextResponse.json(wishErrorBody(r.reason), { status: wishFailureStatus(r.reason) }));
  return noStore(NextResponse.json({ productId, count: r.value.count }, { status: r.value.created ? 201 : 200 }));
});
