import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { broadcastDetail } from "../../../../../lib/server/broadcast/detail";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 방송 상세(SA-055). ?cursor=이전 응답 nextCursor(주문 다음 쪽). 응답 { broadcast, summary(요약 API와 같은 모양),
// orders: [{ id, orderNo, nickname, items: [{ productName, optionName, quantity, unitPrice }], totalAmount, refundAmount, status, createdAt, paidAt, completedAt }],
// nextCursor, hits: [{ id, cardName, note, nickname, order: { id, orderNo } | null, createdAt }] }.
// 대표자·「방송 진행」(BROADCAST_RUN) 직원만(그 밖 403), 다른 판매자 방송은 404. 플랜 기능 OVERLAY.
export async function GET(req: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await broadcastDetail(prisma, ctx, (await params).broadcastId, new URL(req.url).searchParams.get("cursor"))));
  } catch (e) {
    return errorResponse(e);
  }
}
