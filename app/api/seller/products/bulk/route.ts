import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { bulkProducts } from "../../../../../lib/server/products/bulk";

// 선택 상품 일괄 처리(PRODUCT_MANAGE). 본문: { action: "status", status, productIds } | { action: "delete", productIds } (1~200개)
// + 낙관적 잠금(선택) expected: [{ productId, expectedPrice?(정수), expectedStatus?(판매 상태) }] (productIds 안의 상품만, 상품마다 하나, 화면이 본 값).
// 응답 { updated: [productId], skipped: [{ productId, reason: "not_found" | "no_sellable_option" | "price_conflict" | "status_conflict", currentPrice?, currentStatus? }] }
// 잠근 지금 값이 expected와 다른 상품은 바꾸지 않고 skipped에 price_conflict(currentPrice)·status_conflict(currentStatus)로 돌려주고 나머지는 처리한다(요청 전체를 409로 막지 않음). 형식이 틀리면 400.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await bulkProducts(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json(r.value);
});
