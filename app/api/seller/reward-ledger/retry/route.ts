import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { retryFailedRewards } from "../../../../../lib/server/rewards/settle";

// 실패한 적립 원장 재시도(SA-032 「실패 N건 재시도」). 본문 { ids?: UUID[](없으면 처리할 수 있는 실패 전체, 최대 200) }.
// 응답 { requested, result: { settled(이번에 성공), failed(다시 실패), … skipped: null|"not_live" } }. 탈퇴 회원으로 닫힌 줄·성공 줄·다른 쇼핑몰 줄은 바꾸지 않는다. 실패 400 invalid_retry. MEMBER_POINTS.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await retryFailedRewards(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: "재시도할 줄을 확인해 주십시오" }, { status: 400 });
  return NextResponse.json({ requested: r.requested, result: r.result }, { headers: { "cache-control": "no-store" } });
});
