import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { getProductDetail, setProductDetail } from "../../../../../../lib/server/products/detail";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 상세 페이지. 응답 { blocks: [{ type: "text", text } | { type: "image", imageId, url, width, height }], images: [상세 사진 전부] }
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { productId } = await params;
    if (!UUID.test(productId)) return notFound();
    return NextResponse.json(await getProductDetail(prisma, ctx, productId));
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문 { blocks: [{ type: "text", text(1~2000자) } | { type: "image", imageId(상세 사진) }] } 최대 30개, 통째로 바꾼다.
export const PUT = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  const r = await setProductDetail(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json(r.value);
});
