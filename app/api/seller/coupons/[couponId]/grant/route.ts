import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { GRANT_MAX, grantCoupon, type GrantFailure } from "../../../../../../lib/server/shop-coupons/service";

// 직접 지급(발급 방식 「직접 지급」 쿠폰). 본문 { gradeIds?: uuid[], buyerMemberIds?: uuid[] }. 이미 받은 회원은 건너뛴다.
// 응답 { granted, skipped }. 대표자·적립금(MEMBER_POINTS) 직원만.
const MESSAGES: Record<GrantFailure, string> = {
  invalid_target: "지급할 등급이나 회원을 골라 주십시오.",
  not_manual: "직접 지급 쿠폰만 지급할 수 있습니다.",
  not_started: "사용 시작 전인 쿠폰은 지급할 수 없습니다. 사용 시작 뒤에 지급해 주십시오.",
  ended: "종료되었거나 발급을 중지한 쿠폰은 지급할 수 없습니다.",
  issue_limit: "발급 수량 한도를 넘습니다. 한도를 올리거나 대상을 줄여 주십시오.",
  too_many_members: `한 번에 ${GRANT_MAX.toLocaleString("ko-KR")}명까지 지급할 수 있습니다.`,
};

export const POST = mutation(async (req: Request, { params }: { params: Promise<{ couponId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await grantCoupon(prisma, ctx, (await params).couponId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: MESSAGES[r.reason] }, { status: r.reason === "issue_limit" ? 409 : 400 });
  return NextResponse.json(r);
});
