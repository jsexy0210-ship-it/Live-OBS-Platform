import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { PLAN_CHANGE_STATUS, changePlan } from "../../../../../lib/server/billing/planChange";
import { billingProvider } from "../../../../../lib/server/billing/registry";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";

// 플랜 변경(대표자 전용, ONQ 1-C-2). 본문 { planCode: "OVERLAY_ONLY" | "INTEGRATED", expectedAmount? }. 체험하기가 끝나도 열린다.
// expectedAmount: 화면에서 확인받은 지금 낼 금액(미리보기 chargeNow, 0 이상 정수, 필수). 서버가 계산한 금액과 같을 때만 바꾸고
// 다르면 409 amount_changed로 아무것도 바꾸지 않는다. 형식이 틀리면 400 bad_request. 없으면 다른 거절 사유(same_plan 등)가 먼저이고,
// 그런 사유가 없을 때 400 amount_required(변경 불가 플랜은 화면이 금액 없이 보내므로 원래 사유를 돌려준다). 예약 취소(canceled_pending)는 결제가 없어 금액 없이도 된다.
// 성공 { ok, applied: "now" | "next_payment" | "canceled_pending", charged, planCode, effectiveAt }.
// 상위 변경 결제가 거절되면 402 payment_failed, 결과를 아직 모르면 202 payment_pending(그동안 지금 플랜 그대로).
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const body = await readJson<{ planCode: string; expectedAmount: unknown }>(req);
  const expected = body.expectedAmount;
  if (expected !== undefined && !(Number.isInteger(expected) && (expected as number) >= 0)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await changePlan(prisma, billingProvider(), ctx, { planCode: body.planCode, expectedAmount: expected as number | undefined, requireExpectedAmount: true });
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: PLAN_CHANGE_STATUS[r.reason] });
  return NextResponse.json(r);
});
