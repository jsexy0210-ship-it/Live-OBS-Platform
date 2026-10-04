import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../lib/server/http/route";
import { returnError } from "../../../../../lib/server/shop-returns/http";
import { buyerReturnContext, createReturn } from "../../../../../lib/server/shop-returns/service";

// 이 주문의 교환·반품 신청 화면 정보(SH-022-R): 신청 가능 여부(blocked 이유), 교환할 품목, 지난·진행 중인 신청. ?orderId 필수. 남의 주문은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const ctx = await buyerReturnContext(prisma, b.scope, new URL(req.url).searchParams.get("orderId") ?? "");
  return noStore(ctx ? NextResponse.json(ctx) : NextResponse.json({ error: "not_found" }, { status: 404 }));
}

// 신청. body { orderId, kind: "RETURN"|"EXCHANGE", reason, reasonText?, orderItemIds?(교환만), imageIds? }.
// 반품은 주문 전체. 배송 완료 뒤 구매 확정 전인 결제 완료 주문만(409 not_returnable), 진행 중인 신청이 있으면 409 active_exists.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<Record<string, unknown>>(req);
  const r = await createReturn(prisma, b.scope, typeof body.orderId === "string" ? body.orderId : "", body, requestMeta(req));
  if (!r.ok) return noStore(returnError(r.reason, "buyer"));
  return noStore(NextResponse.json({ request: r.request }, { status: 201 }));
});
