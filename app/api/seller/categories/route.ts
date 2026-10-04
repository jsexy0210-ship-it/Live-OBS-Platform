import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { createCategory, listCategories } from "../../../../lib/server/shop-category/service";

// 카테고리 트리(SA-015, PRODUCT_MANAGE). 응답 { categories: [{ id, name, visible, sortOrder, productCount, children: [...] }] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ categories: await listCategories(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문: { name, parentId?(대분류 id, 빼면 대분류), visible?(기본 true) }. 맨 뒤에 추가. 응답은 바뀐 트리.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createCategory(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json({ categories: r.value }, { status: 201 });
});
