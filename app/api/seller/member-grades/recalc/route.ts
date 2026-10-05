import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { gradeError } from "../../../../../lib/server/shop-member-grades/http";
import { recalcNow } from "../../../../../lib/server/shop-member-grades/service";

// 지금 재산정(MEMBER_POINTS): 자동 재산정 켜짐과 상관없이 지금 기준으로 한 번 계산한다. 기준 금액이 순서대로 커야 한다(400 invalid_thresholds_for_run).
// 응답 { promoted, demoted, unchanged }. 고정한 회원은 건드리지 않는다. 로그 추적 member_grade.recalc_now.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await recalcNow(prisma, ctx);
  return r.ok ? noStore(NextResponse.json({ promoted: r.promoted, demoted: r.demoted, unchanged: r.unchanged })) : gradeError(r.reason);
});
