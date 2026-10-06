import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { REWARD_ADJUST_MESSAGES, REWARD_ADJUST_STATUS, adjustRewardBalance } from "../../../../../../lib/server/rewards/adjust";

// 적립금 수동 조정(SA-033). 본문: { direction: "GRANT"(지급)|"REVOKE"(회수), amount: 1원 이상 정수, reason: 사유(필수, 최대 200자), requestId?: UUID(재시도 중복 방지) }.
// 응답: { adjustment: { id, type, amount(부호 있음), status(SUCCEEDED=바로 반영·PENDING=실제 지급 꺼짐으로 대기), reason, createdAt, processedAt }, balance, balanceAfter(대기면 null), replayed }.
// 실패: { error, message } — invalid_reward_adjust 400 · reward_adjust_member_not_found 404 · reward_adjust_insufficient 409(회수가 잔액보다 큼) · reward_adjust_conflict 409.
// MEMBER_POINTS 권한(대표자·권한 있는 직원). 로그 추적에 사유와 함께 남긴다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ memberId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { memberId } = await params;
  const r = await adjustRewardBalance(prisma, ctx, memberId, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: REWARD_ADJUST_MESSAGES[r.reason] }, { status: REWARD_ADJUST_STATUS[r.reason] });
  const { id, type, amount, status, reason, createdAt, processedAt } = r.entry;
  return NextResponse.json({ adjustment: { id, type, amount, status, reason, createdAt, processedAt }, balance: r.balance, balanceAfter: r.balanceAfter, replayed: r.replayed });
});
