import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore } from "../../../../../../lib/server/http/route";
import { cancelRestock, restockErrorBody, restockFailureStatus } from "../../../../../../lib/server/shop-restock-alerts/service";

// 재입고 알림 취소(상품 id). 응답 { removed, count }. 신청하지 않은 상품이면 404.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; productId: string }> }) => {
  const { slug, productId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await cancelRestock(prisma, b.scope, productId);
  if (!r.ok) return noStore(NextResponse.json(restockErrorBody(r.reason), { status: restockFailureStatus(r.reason) }));
  if (!r.value.removed) return noStore(NextResponse.json(restockErrorBody("restock_alert_not_found"), { status: 404 }));
  return noStore(NextResponse.json(r.value));
});
