import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../../../lib/server/http/route";
import { getOrderItemImage } from "../../../../../../../../lib/server/orders/read";
import { imageResponse } from "../../../../../../../../lib/server/shop-content/image";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ orderId: string; itemId: string }> };

function privateResponse(res: Response) {
  res.headers.set("cache-control", "private, no-store");
  res.headers.set("vary", "Cookie");
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("content-security-policy", "default-src 'none'; sandbox");
  return res;
}

// SA022 주문 상품 이미지 읽기. 구독 잠금·쇼핑몰 폐점 중에도 기존 주문 후속 조회를 허용한다.
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const { orderId, itemId } = await params;
    if (!UUID.test(orderId) || !UUID.test(itemId)) return privateResponse(NextResponse.json({ error: "not_found" }, { status: 404 }));
    const image = await getOrderItemImage(prisma, ctx, orderId, itemId);
    return privateResponse(image ? imageResponse(req, image, "private") : NextResponse.json({ error: "not_found" }, { status: 404 }));
  } catch (e) {
    return privateResponse(errorResponse(e));
  }
}
