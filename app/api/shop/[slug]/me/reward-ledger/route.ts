import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../../lib/server/http/route";
import { listBuyerRewardLedger } from "../../../../../../lib/server/rewards/buyerLedger";

// 구매자 본인의 적립금 내역(SH-023). GET ?type=all|earn|use|clawback|expire&cursor&limit(기본 20, 최대 50) → { items:[{ id, at, type, text, productSummary, amount }], nextCursor }.
// 로그인한 쇼핑몰 회원 본인 값만(세션으로 정함), 잠긴 쇼핑몰이어도 연다(me/rewards와 같음).
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    const u = new URL(req.url).searchParams;
    const r = await listBuyerRewardLedger(prisma, b.scope, { type: u.get("type"), cursor: u.get("cursor"), limit: u.get("limit") });
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    return noStore(NextResponse.json({ items: r.items, nextCursor: r.nextCursor }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
