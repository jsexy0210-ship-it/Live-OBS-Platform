import { NextResponse } from "next/server";
import { PURCHASE_FAILURE_STATUS, SHOP_NOT_SUPPORTED_MESSAGE, purchaseAutomation } from "../../../../lib/server/automation/purchase";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../lib/server/billing/registry";
import { prisma } from "../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";

// 자동 연결 구매(대표자 전용, 110,000원). Idempotency-Key 헤더와 결제 전 고지 동의 { consent: { agreed, noticeVersion } } 필수.
// 같은 키로 다시 보내면 처음 결과를 돌려준다. 결제 결과를 아직 모르면 202(작업은 결제 대기). 실행은 서버가 결제를 확인한 뒤에만 시작된다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const body = await readJson<{ consent: unknown; shopUrl: unknown }>(req);
  const r = await purchaseAutomation(prisma, billingProvider(), ctx, { idempotencyKey: req.headers.get("idempotency-key"), consent: body.consent, shopUrl: body.shopUrl });
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, ...(r.reason === "shop_not_supported" ? { message: SHOP_NOT_SUPPORTED_MESSAGE } : {}), ...(r.jobId ? { jobId: r.jobId } : {}) }, { status: PURCHASE_FAILURE_STATUS[r.reason] }));
  return noStore(NextResponse.json(r, { status: r.paymentStatus === "PENDING" ? 202 : r.replayed ? 200 : 201 }));
});
