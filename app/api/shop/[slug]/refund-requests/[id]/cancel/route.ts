import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, requestMeta } from "../../../../../../../lib/server/http/route";
import { cancelRefundRequest, refundRequestError } from "../../../../../../../lib/server/payments/refundRequest";

// 환불 요청 철회: 요청 단계만(409 invalid_transition). 남의 요청은 404.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) => {
  const { slug, id } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await cancelRefundRequest(prisma, b.scope, id, requestMeta(req));
  if (!r.ok) {
    const e = refundRequestError(r.reason, "buyer");
    return noStore(NextResponse.json(e.body, { status: e.status }));
  }
  return noStore(NextResponse.json({ request: r.request }));
});
