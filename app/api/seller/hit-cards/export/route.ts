import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { exportHitCards, HIT_MESSAGES } from "../../../../../lib/server/broadcast/hitCards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// HIT 카드 기록 내려받기(SA-053 「내보내기」, UTF-8 BOM CSV). 목록과 같은 ?broadcastId=&grade=&from=&to= 조건의 카드 전체(최신순 최대 5,000건, 넘으면 X-Export-Truncated: 1). BROADCAST_RUN 권한.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const q = new URL(req.url).searchParams;
    const r = await exportHitCards(prisma, ctx, { broadcastId: q.get("broadcastId"), from: q.get("from"), to: q.get("to"), grade: q.get("grade") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: HIT_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="hit-cards.csv"', ...(r.truncated ? { "x-export-truncated": "1" } : {}) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
