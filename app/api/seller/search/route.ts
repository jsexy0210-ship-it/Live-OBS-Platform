import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { parseQuery, sellerSearch } from "../../../../lib/server/search/service";

// 파트너스 전역 검색. 항상 내 쇼핑몰 안에서만 찾는다. ?q=(최대 50자, 비면 빈 결과)
// → { products, orders, members, inquiries: [{ id, title, sub, href }] } 종류별 최대 5건. 권한이 없는 종류는 빈 목록.
// 구독이 잠기거나 이용 정지 중에도 이미 받은 주문·문의를 찾을 수 있게 열어 둔다(주문 후속 처리와 같은 기준). 상품은 상품 관리 권한 기준.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = parseQuery(new URL(req.url).searchParams.get("q"));
    if (!p.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    return noStore(NextResponse.json(await sellerSearch(prisma, ctx, p.q)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
