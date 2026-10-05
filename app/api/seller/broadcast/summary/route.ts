import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { broadcastSummary } from "../../../../../lib/server/broadcast/summary";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 방송 대시보드(SA-001) 요약: 지금 방송(없으면 오늘 시작한 가장 최근 방송)의 주문 수·결제 주문 수·매출(결제 − 환불)·개봉 완료·취소·HIT 수.
// 응답 { broadcast: { id, title, status(live·ended), startedAt, endedAt } | null, summary: { orders, paidOrders, sales, completed, cancelled, hits } }.
// 대표자·「방송 진행」(BROADCAST_RUN) 직원만(그 밖 403), 플랜 기능 OVERLAY. 귀속 규칙은 lib/server/broadcast/summary.ts.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await broadcastSummary(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}
