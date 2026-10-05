import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { funnelStats } from "../../../../../lib/server/stats/funnel";
import { statsResponse } from "../../../../../lib/server/stats/http";

// 전환 단계(상품 상세 → 장바구니 → 주문 → 결제). SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS. 쿼리: from·to(KST 날짜, 최대 366일).
// 조회·담기는 로그인한 구매자 회원만 센 값이다(basis: "login_members", 화면에 「로그인 회원 기준」 표기). 비회원 조회는 기록하지 않는다.
// 응답: { range, basis, totals{views,cartAdds,orders,paidOrders,viewToCart,cartToOrder,orderToPaid}, products[상위 20: productId,name,...같은 항목] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return await statsResponse(req, (range) => funnelStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
