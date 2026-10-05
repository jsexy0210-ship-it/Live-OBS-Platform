import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, requestSupplement } from "../../../../../../lib/server/sellers/applications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 보완 요청(MA-013·014, seller.moderate). 본문 { reason(1~200자) }. 7일 기한을 걸고 신청 상태가 「보완 요청」이 된다. 기한이 지나면 정기 작업이 자동 반려한다.
// 200 { ok, dueAt } · 400 reason_required · 404 not_found · 409 not_pending·already_requested
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found", message: APPLICATION_MESSAGES.not_found }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const r = await requestSupplement(prisma, admin, sellerId, body.reason, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason] }, { status: r.reason === "reason_required" ? 400 : r.reason === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true, dueAt: r.dueAt });
});
