import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { liftRestriction } from "../../../../../../lib/server/orders/overdue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 구매 제한 풀기(MEMBER_POINTS, 감사 로그). 본문: { reason?(200자 이하, 줄바꿈 허용) }. 사유 글자가 잘못되면 400, 걸린 제한이 없으면 404.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ buyerMemberId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { buyerMemberId } = await params;
  if (!UUID.test(buyerMemberId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: unknown }>(req);
  const r = await liftRestriction(prisma, ctx, buyerMemberId, body.reason);
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: r.reason === "invalid_reason" ? 400 : 404 });
  return NextResponse.json(r.value);
});
