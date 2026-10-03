import { NextResponse } from "next/server";
import { PURCHASE_FAILURE_STATUS, SHOP_NOT_SUPPORTED_MESSAGE, reconnectAutomation } from "../../../../lib/server/automation/purchase";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../lib/server/billing/registry";
import { prisma } from "../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";

// 재연결·재설치(대표자 전용). body { target: { shopKey, obsPairingId }, consent? }, 헤더 Idempotency-Key.
// 완료 뒤 30일 안 같은 쇼핑몰·같은 PC면 무료로 바로 대기열(201). 아니면 consent 없이 오면 402 + 금액·사유,
// consent를 붙여 다시 오면 33,000원 재설치로 결제한다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const body = await readJson<{ target: unknown; consent: unknown; shopUrl: unknown }>(req);
  const r = await reconnectAutomation(prisma, billingProvider(), ctx, { idempotencyKey: req.headers.get("idempotency-key"), consent: body.consent, target: body.target, shopUrl: body.shopUrl });
  if (r.ok) return noStore(NextResponse.json(r, { status: r.paymentStatus === "PENDING" ? 202 : r.replayed ? 200 : 201 }));
  if (r.reason === "bad_target") return noStore(NextResponse.json({ error: r.reason }, { status: 400 }));
  if (r.reason === "payment_required") return noStore(NextResponse.json({ error: r.reason, paidReason: r.paidReason, price: r.price }, { status: 402 }));
  return noStore(NextResponse.json({ error: r.reason, ...(r.reason === "shop_not_supported" ? { message: SHOP_NOT_SUPPORTED_MESSAGE } : {}), ...(r.jobId ? { jobId: r.jobId } : {}) }, { status: PURCHASE_FAILURE_STATUS[r.reason] }));
});
