import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, bulkReject } from "../../../../../../lib/server/sellers/applications";

// 선택 반려(MA-013, seller.moderate: 최고관리자·운영). 본문 { ids: [신청 쇼핑몰 id, 최대 50], reason(1~200자, 신청자에게 그대로 안내되는 문구) }. 건별로 처리하고 한 건이 실패해도 나머지는 계속한다.
// 200 { rejected, failed, results: [{ id, ok, reason?, message? }] } · 400 invalid_input·reason_required
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; reason?: unknown };
  const r = await bulkReject(prisma, admin, body.ids, body.reason, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ rejected: r.rejected, failed: r.failed, results: r.results.map((x) => (x.reason ? { ...x, message: APPLICATION_MESSAGES[x.reason] } : x)) });
});
