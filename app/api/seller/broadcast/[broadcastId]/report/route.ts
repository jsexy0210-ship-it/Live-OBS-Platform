import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { exportBroadcastReport } from "../../../../../../lib/server/broadcast/insights";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 방송 리포트 내려받기(SA-055 「리포트 내보내기」, UTF-8 BOM CSV). 끝난 방송만(방송 중이면 409 live). 최대 5,000건, 넘으면 응답 머리 X-Export-Truncated: 1. BROADCAST_RUN 권한.
export async function GET(req: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const id = (await params).broadcastId;
    const r = await exportBroadcastReport(prisma, ctx, id, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason }, { status: 409 }));
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="broadcast-${id.slice(0, 8)}.csv"`, ...(r.truncated ? { "x-export-truncated": "1" } : {}) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
