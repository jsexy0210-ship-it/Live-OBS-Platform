import { NextResponse } from "next/server";
import { approveSubscriptionRefund, REFUND_MESSAGES } from "../../../../../../lib/server/admin/subscriptionRefunds";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../../../lib/server/billing/registry";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 환불 승인(MA-027) = 결제 공급자에 결제 취소 요청. 요금·청구 변경 권한(최고관리자·운영). 본문 { expectedVersion, note? }.
// 결과 { refund }: status REFUNDED(취소됨)·FAILED(거절, failureReason)·PROCESSING(응답 끊김, 다시 승인하면 같은 환불로 다시 요청).
// 409 version_conflict(+currentVersion)·not_decidable(환불됨·반려됨) · 400 provider_payment_missing·invalid_reason · 404
// 지금 결제 공급자는 시험용 가짜뿐이라 실제 돈은 오가지 않는다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ refundId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const r = await approveSubscriptionRefund(prisma, billingProvider(), admin, (await params).refundId, await readJson(req), requestMeta(req));
  if (!r.ok) {
    const status = r.reason === "version_conflict" || r.reason === "not_decidable" ? 409 : 400;
    return NextResponse.json({ error: r.reason, message: REFUND_MESSAGES[r.reason], ...("currentVersion" in r ? { currentVersion: r.currentVersion } : {}) }, { status });
  }
  return NextResponse.json({ refund: r.refund });
});
