import { NextResponse } from "next/server";
import { purchaseAutomation } from "../../../../lib/server/automation/purchase";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../lib/server/billing/registry";
import { prisma } from "../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../lib/server/http/route";

const STATUS = { bad_idempotency_key: 400, card_required: 409, job_in_progress: 409, payment_failed: 402 } as const;

// 자동 연결 구매(대표자 전용). Idempotency-Key 헤더 필수: 같은 키로 다시 보내면 처음 결과를 돌려준다.
// 결제 결과를 아직 모르면 202(작업은 결제 대기). 실행은 서버가 결제를 확인한 뒤에만 시작된다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const r = await purchaseAutomation(prisma, billingProvider(), ctx, { idempotencyKey: req.headers.get("idempotency-key") });
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, ...(r.jobId ? { jobId: r.jobId } : {}) }, { status: STATUS[r.reason] }));
  return noStore(NextResponse.json(r, { status: r.paymentStatus === "PENDING" ? 202 : r.replayed ? 200 : 201 }));
});
