import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { previewPlanChanges } from "../../../../../../lib/server/billing/planChange";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";

// 플랜별 금액·변경 미리보기(대표자 전용, 구독 화면). 체험하기가 끝나도 열린다. 아무것도 바꾸지 않는다.
// { currentPlanCode, pendingPlanCode, plans: [{ planCode, name, current, price, change }] }
// change: { ok: true, applied, chargeNow, remainingDays, effectiveAt } | { ok: false, reason }(POST …/plan과 같은 사유 코드)
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
    return NextResponse.json(await previewPlanChanges(prisma, ctx));
  } catch (e) {
    return errorResponse(e);
  }
}
