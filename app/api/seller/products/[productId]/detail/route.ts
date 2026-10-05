import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { getProductDetail, setProductDetail } from "../../../../../../lib/server/products/detail";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 상세 페이지. 응답 { blocks: [{ type: "text", text } | { type: "image", imageId, url, width, height }](예전 블록), html(에디터 HTML, 없으면 null), images: [상세 사진 전부] }
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

// 본문은 둘 중 하나(둘 다 있거나 없으면 400 invalid_detail).
// ① { html } 에디터 HTML: 서버가 허용한 태그·속성만 남겨 저장하고 예전 블록은 비운다. 응답에 sanitized: { removedCount }(지운 곳 수). 글자 20,000자까지(넘으면 400 detail_too_long).
//    사진은 이 상품의 상세 사진(?kind=detail로 올린 것)만 쓸 수 있다(src는 업로드 응답 url 그대로, 그 밖의 src는 지운다). 빈 문자열이면 상세 설명을 지운다.
// ② { blocks: [{ type: "text", text(1~2000자) } | { type: "image", imageId(상세 사진) }] } 예전 방식, 최대 30개, 통째로 바꾸고 html은 지운다.
export const PUT = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  const r = await setProductDetail(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json(r.value);
});
