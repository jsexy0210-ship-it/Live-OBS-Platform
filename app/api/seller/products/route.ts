import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { createProduct, listProducts } from "../../../../lib/server/products/manage";

// 판매자 상품 목록·등록(PRODUCT_MANAGE). 잠긴 판매자는 상품을 다룰 수 없다(새 판매 차단, PRODUCT_SCOPE 「잠금 중 허용 범위」).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    const status = new URL(req.url).searchParams.get("status") ?? undefined;
    return NextResponse.json({ products: await listProducts(prisma, ctx, { status }) });
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문: { name, description?, price, status?(기본 DRAFT), sortOrder?, options?: [{ name, priceDelta?, stock?, sku?, sortOrder? }] }
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const r = await createProduct(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  return NextResponse.json(r.value, { status: 201 });
});
