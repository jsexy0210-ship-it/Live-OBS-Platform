import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../lib/server/http/route";
import { buyerRefundRequestContext, createRefundRequest, refundRequestError } from "../../../../../lib/server/payments/refundRequest";

// 이 주문의 환불 요청 화면 정보(SH-022 취소 요청): 요청 가능 여부(blocked 이유), 고를 수 있는 품목(남은 수량), 지난·진행 중인 요청. ?orderId 필수. 남의 주문은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const ctx = await buyerRefundRequestContext(prisma, b.scope, new URL(req.url).searchParams.get("orderId") ?? "");
  return noStore(ctx ? NextResponse.json(ctx) : NextResponse.json({ error: "not_found" }, { status: 404 }));
}

// 요청. body { orderId, reason(CHANGE_OF_MIND·DEFECTIVE·WRONG_ITEM·NOT_AS_DESCRIBED·OTHER), reasonText?(기타면 필수, 500자), items?: [{ orderItemId, quantity }] }.
// 결제 완료·발송 전·구매 확정 전 주문만(409 not_refundable), 진행 중인 요청이 있으면 409 active_exists, 잘못 고른 품목은 400 invalid_items.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<Record<string, unknown>>(req);
  const r = await createRefundRequest(prisma, b.scope, typeof body.orderId === "string" ? body.orderId : "", body, requestMeta(req));
  if (!r.ok) {
    const e = refundRequestError(r.reason, "buyer");
    return noStore(NextResponse.json(e.body, { status: e.status }));
  }
  return noStore(NextResponse.json({ request: r.request }, { status: 201 }));
});
