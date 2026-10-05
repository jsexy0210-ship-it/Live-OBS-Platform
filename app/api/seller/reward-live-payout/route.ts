import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { REWARD_LIVE_PAYOUT_MESSAGES, REWARD_LIVE_PAYOUT_STATUS, readLivePayout, updateLivePayout } from "../../../../lib/server/seller-settings/rewardLivePayout";

// 적립금 실지급 스위치(SA-034). 응답: { livePayout: { enabled, changedAt, changedByName } }(기본 꺼짐, 기록 없으면 null).
// 조회는 MEMBER_POINTS, 변경은 대표자만(그 밖 403). PUT 본문: { enabled: boolean, confirm?: true } — 켤 때 confirm: true 필수(없으면 400 live_payout_confirm_required).
// 값이 그대로면 바꾸지 않는다. 바꾸면 로그 추적에 남긴다. 쇼핑몰이 잠기면 조회·변경 모두 막힌다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ livePayout: await readLivePayout(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateLivePayout(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: REWARD_LIVE_PAYOUT_MESSAGES[r.reason] }, { status: REWARD_LIVE_PAYOUT_STATUS[r.reason] });
  return NextResponse.json({ livePayout: r.livePayout });
});
