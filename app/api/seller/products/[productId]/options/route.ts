import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { createOption } from "../../../../../../lib/server/products/manage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 옵션 추가. 본문: { name, priceDelta?, stock?, sku?, sortOrder? }
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ productId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await createOption(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  return NextResponse.json(r.value, { status: 201 });
});
