import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { previewProduct } from "../../../../../../lib/server/products/preview";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 상품 상세 미리보기(SA-013, 「상품 관리」 보기). 계약은 lib/server/products/preview.ts 머리말.
// GET → { shop{slug,name}, product{id,code,name,description,detail[],detailHtml,isLive,status,price,event,stock,soldOut,visibleToBuyers,images[],categories[](구매자에게 보이는 것만),options[],purchaseLimits(null)},
//        reward{card:{rate,amount}|null,bankTransfer:{rate,amount}|null}|null(구매자 상세와 같은 적립 예정), checks[{key: images|description|price|stock|categories, status: ok|warn, detail}],
//        open{canOpen(판매 중·품절만 true), path}, share{path, card{title,price,imageUrl|null}} }. 없는 상품은 404.
export async function GET(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { productId } = await params;
    if (!UUID.test(productId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await previewProduct(prisma, ctx, productId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
