import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { adminPgStatus } from "../../../../lib/server/payments/adminStatus";

// 마스터 관리자 PG 연결 상태(MA-031, platform.read, 조회만). ?q(쇼핑몰 이름·주소)·cursor·limit(기본 50, 최대 200)·status(all|failed|cancel, 기본 all)·period(24h|7d|30d, 기본 24h).
// { gateway: { provider, configured, mode, lastSuccessAt, lastFailureAt, lastFailureCode, lastFailureMessage,
//     summary24h: { successCount, failureCount, failedSellerCount, cancelsPending, cancelsFailed, lastSuccess: { at, sellerName, amount } | null, lastFailure: { at, sellerName, code, message } | null } },
//   counts: { all, failed, cancel }, sellers: [{ seller, live, lastSuccessAt, lastFailureAt, lastFailureCode, lastFailureMessage, failures24h, failuresInPeriod, cancelsPending, cancelsFailed }], nextCursor }
// summary24h는 period와 상관없이 항상 직전 24시간 기준(구매자 주문 결제 기준)이고, 취소 대기·실패만 처리 안 끝난 건 전체다. period는 failuresInPeriod와 status=failed 필터 기준이다.
// counts는 같은 q·period 기준 상태별 파트너스 수(status·cursor와 무관), status=cancel은 처리 안 끝난 취소(대기·실패)가 있는 파트너스.
// 키 값·비밀정보는 내려주지 않는다(설정 여부만). 잘못된 값이면 400 bad_request.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await adminPgStatus(prisma, admin, { q: p.get("q"), cursor: p.get("cursor"), limit: p.get("limit"), status: p.get("status"), period: p.get("period") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const { ok: _ok, ...body } = r;
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
