import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, recheckBusiness } from "../../../../../../lib/server/sellers/applications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 국세청 사업자 상태 다시 조회(MA-013 검토 패널, seller.moderate: 최고관리자·운영). 신청 때 받은 사업자번호·대표자명·개업일자로 다시 조회하고 사업자 관련 확인 필요 사유를 새 결과로 바꾼다.
// 200 { ok, lookupOk(조회 성공 여부), reasons, checks, checkedAt } · 404 not_found · 409 not_pending·no_business_info·recheck_too_soon(+canRecheckAt) · 429 recheck_limit(한 시간 10번). 조회 키 값은 응답·로그에 담지 않는다.
const STATUS = { not_found: 404, not_pending: 409, no_business_info: 409, recheck_too_soon: 409, recheck_limit: 429 } as const;
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found", message: APPLICATION_MESSAGES.not_found }, { status: 404 });
  const r = await recheckBusiness(prisma, admin, sellerId, { meta: requestMeta(req) });
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason], ...("canRecheckAt" in r ? { canRecheckAt: r.canRecheckAt } : {}) }, { status: STATUS[r.reason] });
  const { ok: _ok, ...body } = r;
  return NextResponse.json({ ok: true, ...body });
});
