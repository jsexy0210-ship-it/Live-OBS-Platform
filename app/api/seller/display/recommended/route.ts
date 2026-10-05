import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { setRecommended } from "../../../../../lib/server/shop-display/service";

// 추천 상품. 본문 { productIds: [...] } 최대 20개, 순서대로 통째로 바꾼다.
// 응답은 바뀐 진열 설정 전체(GET /api/seller/display와 같은 모양). 틀리면 400 invalid_display_settings.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await setRecommended(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json(r.value);
});
