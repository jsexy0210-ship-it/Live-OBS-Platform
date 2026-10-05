import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, bulkApprove } from "../../../../../../lib/server/sellers/applications";

// 선택 승인(MA-013, seller.moderate: 최고관리자·운영). 본문 { ids: [신청 쇼핑몰 id, 최대 50] }. 이상 없음 신청만 승인하고 확인 필요·보완 요청 건은 건별로 거절한다(한 건이 실패해도 나머지는 계속).
// 200 { approved, failed, results: [{ id, ok, reason?, message?, approvedAt?, undoableUntil? }] } · 400 invalid_input
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const r = await bulkApprove(prisma, admin, body.ids, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ approved: r.approved, failed: r.failed, results: r.results.map((x) => (x.reason ? { ...x, message: APPLICATION_MESSAGES[x.reason] } : x)) });
});
