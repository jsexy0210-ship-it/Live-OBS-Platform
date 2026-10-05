import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { deleteProduct, getProduct, updateProduct } from "../../../../../lib/server/products/manage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { productId } = await params;
    if (!UUID.test(productId)) return notFound();
    return NextResponse.json(await getProduct(prisma, ctx, productId));
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문: 바꿀 항목만 { name?, description?, price?, status?, sortOrder?, ... } + 낙관적 잠금(선택) { expectedPrice?(정수), expectedStatus?(판매 상태) }.
// 화면이 본 값과 지금 값이 다르면 바꾸지 않고 409 { error: "price_conflict", message, currentPrice } · { error: "status_conflict", message, currentStatus }.
// 둘 다 없으면 지금 동작 그대로(둘 다 있으면 판매가를 먼저 비교). 형식이 틀리면 400.
export const PATCH = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  const r = await updateProduct(prisma, ctx, productId, await readJson(req));
  if (!r.ok) {
    const body = { ...orderErrorBody(r.reason, "formal"), ...(r.currentPrice === undefined ? {} : { currentPrice: r.currentPrice }), ...(r.currentStatus === undefined ? {} : { currentStatus: r.currentStatus }) };
    return NextResponse.json(body, { status: r.reason === "price_conflict" || r.reason === "status_conflict" ? 409 : 400 });
  }
  return NextResponse.json(r.value);
});

// 소프트 삭제
export const DELETE = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  await deleteProduct(prisma, ctx, productId);
  return NextResponse.json({ ok: true });
});
