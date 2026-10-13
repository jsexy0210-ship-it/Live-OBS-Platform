import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { exportBroadcastHistory } from "../../../../../../lib/server/broadcast/history";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 방송 기록 내려받기(SA-054 「내보내기」, UTF-8 BOM CSV). 목록과 같은 ?from=&to=&layout= 조건의 방송 전체(최신순 최대 5,000건, 넘으면 X-Export-Truncated: 1). BROADCAST_RUN 권한.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const q = new URL(req.url).searchParams;
    const r = await exportBroadcastHistory(prisma, ctx, { from: q.get("from"), to: q.get("to"), layout: q.get("layout") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: "조회 기간을 다시 확인해 주십시오" }, { status: 400 }));
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="broadcast-history.csv"', ...(r.truncated ? { "x-export-truncated": "1" } : {}) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
