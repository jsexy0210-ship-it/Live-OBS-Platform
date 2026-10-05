import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { reorderCategories } from "../../../../../lib/server/shop-category/service";

// 순서 바꾸기. 본문: { parentId: null | 대분류 id, categoryIds: [그 부모 아래 카테고리 전부, 새 순서] }.
// 그사이 추가·삭제로 목록이 달라졌으면 409 invalid_category_order. 응답은 바뀐 트리.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await reorderCategories(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 409 });
  return NextResponse.json({ categories: r.value });
});
