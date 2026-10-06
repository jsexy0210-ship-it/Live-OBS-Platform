import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { REWARD_POLICY_MESSAGES, REWARD_POLICY_STATUS, previewRewardPolicy } from "../../../../../lib/server/rewards/policyAdmin";

// 적립률 변경 영향 미리보기(SA-031). 저장하지 않는다. 본문 { amount, paymentMethod: "CARD"|"BANK_TRANSFER", gradeId, rates? }. 응답 { current: {rate, amount}, next: {rate, amount} }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await previewRewardPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: REWARD_POLICY_MESSAGES[r.reason] }, { status: REWARD_POLICY_STATUS[r.reason] });
  return NextResponse.json({ current: r.current, next: r.next }, { headers: { "cache-control": "no-store" } });
});
