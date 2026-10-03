import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { MEMBER_POLICY_MESSAGES, readMemberPolicy, updateMemberPolicy } from "../../../../lib/server/buyers/rejoin";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";

// 판매자 회원 정책(MEMBER_POINTS). 본문: { rejoinRestrictionEnabled: boolean, rejoinRestrictionDays?: 1~365(빼면 지금 값) }.
// 끄면 남겨 둔 재가입 제한 기록을 모두 지운다. 바꾼 기간은 그 뒤 탈퇴부터.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json({ policy: await readMemberPolicy(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const r = await updateMemberPolicy(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: MEMBER_POLICY_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
