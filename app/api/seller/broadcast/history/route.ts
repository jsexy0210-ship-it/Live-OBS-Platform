import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { broadcastHistory } from "../../../../../lib/server/broadcast/history";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 방송 이력(SA-054). ?from=YYYY-MM-DD&to=YYYY-MM-DD(KST, 끝 포함, 방송 시작일 기준)&cursor= →
// { items: [{ id, title, status(live·ended), startedAt, endedAt, summary: { orders, paidOrders, sales, completed, cancelled, hits } }], nextCursor }(최신순 50개).
// 잘못된 기간은 400 { error: "invalid_range", message }. 대표자·「방송 진행」(BROADCAST_RUN) 직원만(그 밖 403), 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const q = new URL(req.url).searchParams;
    const r = await broadcastHistory(prisma, ctx, { from: q.get("from"), to: q.get("to"), cursor: q.get("cursor") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: "조회 기간을 다시 확인해 주십시오" }, { status: 400 });
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return errorResponse(e);
  }
}
