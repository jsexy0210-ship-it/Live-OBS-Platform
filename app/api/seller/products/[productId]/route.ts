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

// 본문: 바꿀 항목만 { name?, description?, price?, status?, sortOrder? }
export const PATCH = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  const r = await updateProduct(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
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
