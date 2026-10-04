import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { getDisplay } from "../../../../lib/server/shop-display/service";

// 상품 진열(SA-016) 설정. 응답 { listSort, sections: [{ id, kind, categoryId, title, visible, itemCount }], recommended: [{ productId, code, name, status, deleted, thumbnailUrl }] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json(await getDisplay(prisma, ctx));
  } catch (e) {
    return errorResponse(e);
  }
}
