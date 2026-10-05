import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listSellerOrders } from "../../../../lib/server/orders/read";

// 판매자 주문 목록. 쿼리: status(여러 개), q, memberId(회원 한 명의 주문만, UUID), shipped(true|false, 발송 정보 등록 여부), from·to(KST 날짜 YYYY-MM-DD), cursor, limit(기본 50, 최대 200). ORDER_SHIPPING 권한.
export async function GET(req: Request) {
  try {
    // 잠금 중에도 이미 받은 주문은 처리할 수 있다(대표님 결정 2026-10-02, PRODUCT_SCOPE 「잠금 중 허용 범위」).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await listSellerOrders(prisma, ctx, {
      status: p.getAll("status").flatMap((s) => s.split(",")).filter(Boolean),
      q: p.get("q"),
      memberId: p.get("memberId"),
      shipped: p.get("shipped"),
      from: p.get("from"),
      to: p.get("to"),
      cursor: p.get("cursor"),
      limit: p.get("limit"),
    });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ orders: r.orders, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
