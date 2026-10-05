import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson } from "../../../../../lib/server/http/route";
import { applyRestock, listMyRestock, restockErrorBody, restockFailureStatus } from "../../../../../lib/server/shop-restock-alerts/service";

// 내 재입고 알림 신청 목록. 응답 { items: [{ productId, name, status(WAITING·QUEUED·SENT), requestedAt, notifyAt, notifiedAt }], count }. 개인 정보라 캐시하지 않는다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    return noStore(NextResponse.json(await listMyRestock(prisma, b.scope)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 신청하기(지금 품절인 상품만). 본문: { productId }. 새로 신청하면 201, 이미 신청했으면 200. 응답 { productId, count }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const { productId } = await readJson<{ productId: unknown }>(req);
  const r = await applyRestock(prisma, b.scope, productId);
  if (!r.ok) return noStore(NextResponse.json(restockErrorBody(r.reason), { status: restockFailureStatus(r.reason) }));
  return noStore(NextResponse.json({ productId, count: r.value.count }, { status: r.value.created ? 201 : 200 }));
});
