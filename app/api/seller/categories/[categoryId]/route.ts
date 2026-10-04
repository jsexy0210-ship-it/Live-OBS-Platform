import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { deleteCategory, updateCategory } from "../../../../../lib/server/shop-category/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ categoryId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 본문: 바꿀 항목만 { name?, visible? }. 응답은 바뀐 트리.
export const PATCH = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { categoryId } = await params;
  if (!UUID.test(categoryId)) return notFound();
  const r = await updateCategory(prisma, ctx, categoryId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json({ categories: r.value });
});

// 하위 카테고리가 있으면 409 category_has_children. 지우면 상품 연결도 지워진다.
export const DELETE = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { categoryId } = await params;
  if (!UUID.test(categoryId)) return notFound();
  const r = await deleteCategory(prisma, ctx, categoryId);
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 409 });
  return NextResponse.json({ categories: r.value });
});
