import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { createManualRestriction } from "../../../../../lib/server/orders/manualRestriction";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";

// 구매 제한 직접 걸기(MEMBER_POINTS, 로그 추적). 본문: { days?(1~365, 기본 30), note?(200자 이하, 줄바꿈 허용) }.
// 값이 잘못되면 400 invalid_restriction, 이미 걸린 제한이 있으면 409 already_restricted, 탈퇴·다른 쇼핑몰 회원은 404.
// 응답 201 { restriction: { id, buyerMemberId, reason: "MANUAL", note, startsAt, endsAt } }. 풀기는 …/lift.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ buyerMemberId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const b = await readJson<{ days: unknown; note: unknown }>(req);
  const r = await createManualRestriction(prisma, ctx, (await params).buyerMemberId, b);
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: r.reason === "already_restricted" ? 409 : 400 });
  return noStore(NextResponse.json({ restriction: r.value }, { status: 201 }));
});
