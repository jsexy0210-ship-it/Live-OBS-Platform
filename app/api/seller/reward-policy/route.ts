import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { updateEarnTiming } from "../../../../lib/server/rewards/policy";
import { REWARD_POLICY_MESSAGES, REWARD_POLICY_STATUS, readRewardPolicy, updateRewardPolicy } from "../../../../lib/server/rewards/policyAdmin";

// 적립 정책(SA-031, MEMBER_POINTS). 조회 응답 { policy: { configured, earnTiming, revokeMode("AUTO"|"MANUAL"), rankingBonus:{enabled,amount}, livePayoutEnabled, updatedAt, grades:[{id,name,systemKey,minAmount,memberCount,card,bankTransfer}] } }.
// 저장 본문(보낸 항목만 바꿈): { earnTiming?: "ON_PAYMENT"(결제 즉시) | "ON_DELIVERY"(배송 완료 후, 기본), revokeMode?, rankingBonus?: {enabled, amount}, rates?: { [gradeId]: { card?, bankTransfer? } }(0~10%, 소수 1자리, null이면 비움) }.
// 응답 { policy, changed }. 실패 { error, message }: invalid_reward_policy·reward_rate_out_of_range·reward_rate_unit·reward_ranking_bonus_invalid 400, reward_grade_not_found 404.
// 바뀐 적립률은 저장 뒤 결제되는 주문부터 적용된다. 변경 이력은 /api/seller/reward-policy/history, 변경 영향 미리보기는 /api/seller/reward-policy/preview.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ policy: await readRewardPolicy(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const body = await readJson<Record<string, unknown>>(req);
  // 지급 시점만 보내는 기존 호출은 이전 처리(응답 { policy: { earnTiming } })를 그대로 쓴다.
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "earnTiming") {
    const r = await updateEarnTiming(prisma, ctx, body);
    if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
    return NextResponse.json({ policy: { earnTiming: r.earnTiming } });
  }
  const r = await updateRewardPolicy(prisma, ctx, body);
  if (!r.ok) return NextResponse.json({ error: r.reason, message: REWARD_POLICY_MESSAGES[r.reason] }, { status: REWARD_POLICY_STATUS[r.reason] });
  return NextResponse.json({ policy: r.policy, changed: r.changed });
});
