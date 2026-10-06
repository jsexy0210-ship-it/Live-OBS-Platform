import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { exportRewardLedger } from "../../../../../lib/server/rewards/export";

// 적립금 원장 엑셀(CSV) 내려받기(SA-032). 쿼리는 원장 목록과 같다(status·kind·q·memberId·from·to, cursor·limit은 무시). 최대 5,000줄, 넘으면 응답 머리 X-Export-Truncated: 1.
// UTF-8(BOM) CSV, 열: 회원·일시·유형·사유 · 주문·금액·잔액(후)·상태·실패 사유. MEMBER_POINTS 조회 권한, 잠금 중에도 받을 수 있다(원장 목록과 같은 기준). 내려받은 사실은 로그 추적에 남는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await exportRewardLedger(prisma, ctx, { status: p.get("status"), kind: p.get("kind"), q: p.get("q"), memberId: p.get("memberId"), from: p.get("from"), to: p.get("to") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="reward-ledger-${day}.csv"`, ...(r.truncated ? { "x-export-truncated": "1" } : {}) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
