import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { PLAN_CHANGE_STATUS, changePlan } from "../../../../../lib/server/billing/planChange";
import { billingProvider } from "../../../../../lib/server/billing/registry";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";

// 플랜 변경(대표자 전용, ONQ 1-C-2). 본문 { planCode: "OVERLAY_ONLY" | "INTEGRATED" }. 체험하기가 끝나도 열린다.
// 성공 { ok, applied: "now" | "next_payment" | "canceled_pending", charged, planCode, effectiveAt }.
// 상위 변경 결제가 거절되면 402 payment_failed, 결과를 아직 모르면 202 payment_pending(그동안 지금 플랜 그대로).
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const body = await readJson<{ planCode: string }>(req);
  const r = await changePlan(prisma, billingProvider(), ctx, { planCode: body.planCode });
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: PLAN_CHANGE_STATUS[r.reason] });
  return NextResponse.json(r);
});
