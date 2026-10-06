import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { exportRewardBalances } from "../../../../../lib/server/rewards/export";

// 회원별 적립금 잔액 엑셀(CSV) 내려받기(SA-033). 쿼리 q(방송 닉네임)는 목록과 같다. 최대 5,000줄, 넘으면 응답 머리 X-Export-Truncated: 1.
// UTF-8(BOM) CSV, 열: 회원·잔액·누적 지급·누적 사용·누적 회수·소멸·수동 조정·마지막 변동. MEMBER_POINTS 조회 권한, 잠금 중에도 받을 수 있다. 내려받은 사실은 로그 추적에 남는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const r = await exportRewardBalances(prisma, ctx, { q: new URL(req.url).searchParams.get("q") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="reward-balances-${day}.csv"`, ...(r.truncated ? { "x-export-truncated": "1" } : {}) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
