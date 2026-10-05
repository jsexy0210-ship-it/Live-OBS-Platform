import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { receiptError, retryReceiptIssue } from "../../../../../../lib/server/receipts/service";

// 실패한 발행 다시 시도(RECEIPT_TAX): 실패 → 대기. 실패가 아니면 409 invalid_transition. 로그 추적 receipt_issue.retry.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await retryReceiptIssue(prisma, ctx, (await params).id);
  if (!r.ok) {
    const e = receiptError(r.reason, "seller");
    return NextResponse.json(e.body, { status: e.status });
  }
  return noStore(NextResponse.json({ request: r.request }));
});
