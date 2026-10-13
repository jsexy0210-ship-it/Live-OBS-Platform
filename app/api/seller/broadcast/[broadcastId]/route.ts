import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { broadcastDetail } from "../../../../../lib/server/broadcast/detail";
import { prisma } from "../../../../../lib/server/db";
import { saveBroadcastMemo } from "../../../../../lib/server/broadcast/insights";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 방송 상세(SA-055). ?cursor=이전 응답 nextCursor(주문 다음 쪽). 응답 { broadcast, summary(요약 API와 같은 모양),
// orders: [{ id, orderNo, nickname, items: [{ productName, optionName, quantity, unitPrice }], totalAmount, refundAmount, status, createdAt, paidAt, completedAt, openSeconds(개봉을 모두 마친 주문의 개봉 시간 초|null) }],
// nextCursor, hits: [{ id, cardName, note, nickname, order: { id, orderNo } | null, createdAt }] }.
// summary에 avgOpenSeconds(평균 오픈 초, 없으면 null)·maxWaiting(최대 대기 건), hourly: [{ at(10분 칸 시작), orders }], broadcast.memo.
// 대표자·「방송 진행」(BROADCAST_RUN) 직원만(그 밖 403), 다른 판매자 방송은 404. 플랜 기능 OVERLAY.
export async function GET(req: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await broadcastDetail(prisma, ctx, (await params).broadcastId, new URL(req.url).searchParams.get("cursor"))));
  } catch (e) {
    return errorResponse(e);
  }
}

// 방송 메모 저장(방송당 한 칸). 본문 { memo: string(최대 1,000자, 빈 글자는 지우기) } → { memo }. BROADCAST_RUN 권한, 다른 판매자 방송은 404.
export const PATCH = mutation(async (req: Request, { params }: { params: Promise<{ broadcastId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const r = await saveBroadcastMemo(prisma, ctx, (await params).broadcastId, (await readJson<{ memo: unknown }>(req)).memo, requestMeta(req));
  return noStore(NextResponse.json(r.ok ? { memo: r.memo } : { error: r.reason }, { status: r.ok ? 200 : 400 }));
});
