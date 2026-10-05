import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { bulkProducts } from "../../../../../lib/server/products/bulk";

// 선택 상품 일괄 처리(PRODUCT_MANAGE). 본문: { action: "status", status, productIds } | { action: "delete", productIds } (1~200개)
// 응답 { updated: [productId], skipped: [{ productId, reason: "not_found" | "no_sellable_option" }] }
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await bulkProducts(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json(r.value);
});
