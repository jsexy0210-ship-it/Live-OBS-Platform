import { NextResponse } from "next/server";
import { REFUND_MESSAGES, rejectSubscriptionRefund } from "../../../../../../lib/server/admin/subscriptionRefunds";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 환불 반려(MA-027). 요금·청구 변경 권한(최고관리자·운영). 요청·실패 상태만. 본문 { note(사유, 필수), expectedVersion }.
// 409 version_conflict(+currentVersion)·not_decidable · 400 invalid_reason · 404
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ refundId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const r = await rejectSubscriptionRefund(prisma, admin, (await params).refundId, await readJson(req), requestMeta(req));
  if (!r.ok) {
    const status = r.reason === "version_conflict" || r.reason === "not_decidable" ? 409 : 400;
    return NextResponse.json({ error: r.reason, message: REFUND_MESSAGES[r.reason], ...("currentVersion" in r ? { currentVersion: r.currentVersion } : {}) }, { status });
  }
  return NextResponse.json({ refund: r.refund });
});
