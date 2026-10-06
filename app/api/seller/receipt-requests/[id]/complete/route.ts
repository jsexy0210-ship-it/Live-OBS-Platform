import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { completeReceiptIssue } from "../../../../../../lib/server/receipts/manual";
import { receiptError } from "../../../../../../lib/server/receipts/service";

// 직접 발행한 건을 발행 완료 처리(SA-024, RECEIPT_TAX): 발행 대기 → 발행 완료, 구매자 안내 기록·로그 추적(receipt_issue.complete). 대기가 아니면 409 invalid_transition, 입금 전이면 409 not_paid.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await completeReceiptIssue(prisma, ctx, (await params).id);
  if (!r.ok) {
    const e = receiptError(r.reason, "seller");
    return NextResponse.json(e.body, { status: e.status });
  }
  return noStore(NextResponse.json({ request: r.request }));
});
