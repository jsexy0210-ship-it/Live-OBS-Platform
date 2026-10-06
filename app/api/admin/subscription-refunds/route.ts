import { NextResponse } from "next/server";
import { createSubscriptionRefund, listSubscriptionRefunds, REFUND_MESSAGES } from "../../../../lib/server/admin/subscriptionRefunds";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";

// 구독 환불 요청 목록(MA-026). 보기는 마스터 관리자 전 역할. ?status=REQUESTED|PROCESSING|REFUNDED|FAILED|REJECTED&cursor=
// → { items: [{ id, sellerId, shopName, slug, paymentId, amount, source, reason, status, decisionNote, failureReason, version, createdAt, decidedAt, refundedAt,
//   requestedByAdminId, decidedByAdminId, payment: { amount, kind, periodStart, periodEnd, paidAt, receiptUrl } }], counts: { 상태별 수 }, summary: { monthRefunded: { count, amount }, avgProcessDays }, nextCursor } (각 항목에 assignee) · ?status=pending|done|rejected 묶음도 받는다
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const url = new URL(req.url);
    const r = await listSubscriptionRefunds(prisma, admin, { status: url.searchParams.get("status"), cursor: url.searchParams.get("cursor") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: REFUND_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(NextResponse.json({ items: r.items, counts: r.counts, summary: r.summary, nextCursor: r.nextCursor }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 마스터 관리자가 직접 환불 요청 만들기(법이 요구하는 환불 등). 요금·청구 변경 권한(최고관리자·운영). 본문 { paymentId, amount, reason }.
// 201 { refund } · 400 invalid_amount·invalid_reason·payment_not_paid · 404 payment_not_found · 409 already_requested
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const r = await createSubscriptionRefund(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) {
    const status = r.reason === "payment_not_found" ? 404 : r.reason === "already_requested" ? 409 : 400;
    return NextResponse.json({ error: r.reason, message: REFUND_MESSAGES[r.reason] }, { status });
  }
  return NextResponse.json({ refund: r.refund }, { status: 201 });
});
