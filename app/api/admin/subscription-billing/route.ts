import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { adminSubscriptionBilling } from "../../../../lib/server/payments/adminStatus";

// 마스터 관리자 구독료 수납 현황(MA-032, platform.read, 조회만). ?from·to(KST 날짜 YYYY-MM-DD, 청구 시각 기준, 끝 날짜 포함, 최대 366일, 없으면 오늘).
// { range, summary: { charged, paid, failed, pending, paidAmount, failedAmount, retrying, pastDue, grace, pastDueAmount, locked, retryBySeq }, daily: [{ date, charged, paid, failed, pending, retried, pastDueStarted, paidAmount }] }
// retryBySeq: 연체 구독의 재시도 대기 건수를 시도 차수(1차=최초 청구)별로({ "2": n, "3": n … 최대 재시도 + 1까지}). pastDueAmount: 연체 구독마다 마지막 실패한 기간 청구 금액 합. locked: 연체 유예가 끝나 이용이 막힌 건수.
// retried·pastDueStarted는 감사 로그 날짜별 건수라 이 기능 이전 날짜는 0(subscription.payment_retry·subscription.past_due).
// 목록은 GET /api/admin/payments, 연체·유예 파트너스는 GET /api/admin/subscriptions?access=. 잘못된 기간이면 400 bad_request.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await adminSubscriptionBilling(prisma, admin, { from: p.get("from"), to: p.get("to") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const { ok: _ok, ...body } = r;
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
