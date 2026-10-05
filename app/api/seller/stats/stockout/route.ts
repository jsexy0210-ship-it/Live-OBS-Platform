import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { STOCKOUT_DAYS, STOCKOUT_DEFAULT_DAYS, stockoutStats } from "../../../../../lib/server/stats/stockout";

// 재고 소진 속도. SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS. 쿼리: days(7·14·30, 기본 14).
// 응답: { range{days,from,to}, atRisk(7일 안에 떨어질 옵션 수), total, rows[상위 20: optionId,productId,productName,optionName,stock,sold,perDay,daysLeft] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const raw = new URL(req.url).searchParams.get("days");
    const days = raw === null || raw === "" ? STOCKOUT_DEFAULT_DAYS : Number(raw);
    if (!(STOCKOUT_DAYS as readonly number[]).includes(days)) return noStore(NextResponse.json({ error: "bad_days" }, { status: 400 }));
    return noStore(NextResponse.json(await stockoutStats(prisma, ctx, days)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
