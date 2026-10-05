import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../../lib/server/http/route";
import { returnError } from "../../../../../../../lib/server/shop-returns/http";
import { buyerShipBack } from "../../../../../../../lib/server/shop-returns/service";

// 돌려보낸 송장 입력(접수 단계). body { courier, trackingNumber }
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) => {
  const { slug, id } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await buyerShipBack(prisma, b.scope, id, await readJson<Record<string, unknown>>(req), requestMeta(req));
  if (!r.ok) return noStore(returnError(r.reason, "buyer"));
  return noStore(NextResponse.json({ request: r.request }));
});
