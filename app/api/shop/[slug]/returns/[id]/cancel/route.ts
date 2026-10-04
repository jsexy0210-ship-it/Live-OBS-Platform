import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, requestMeta } from "../../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../../lib/server/shop-returns/http";
import { buyerCancelReturn } from "../../../../../../../lib/server/shop-returns/service";

// 신청 철회: 신청·접수 단계만(409 invalid_transition). 남의 신청은 404.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) => {
  const { slug, id } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await buyerCancelReturn(prisma, b.scope, id, requestMeta(req));
  if (!r.ok) return noStore(returnError(r.reason, "buyer"));
  return noStore(NextResponse.json({ request: r.request }));
});
