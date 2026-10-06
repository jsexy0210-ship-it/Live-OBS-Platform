import { NextResponse } from "next/server";
import { PURCHASE_FAILURE_STATUS, SHOP_NOT_SUPPORTED_MESSAGE, startOneTimeCardPurchase } from "../../../../../lib/server/automation/purchase";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { requestOrigin } from "../../../../../lib/server/branding/siteUrl";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { paymentGateway } from "../../../../../lib/server/payments/registry";
import { requireSellerPermission } from "../../../../../lib/server/tenant/context";

// 자동 연결 「다른 카드로 결제」 시작(대표자 전용, 이번 한 번만·카드 저장 안 함). 본문·헤더는 POST /api/automation/purchase와 같다(Idempotency-Key, consent, shopUrl).
// 금액은 서버가 정한다. 응답 201/200: { jobId, paymentId, paymentStatus, replayed, window: {clientId, method, orderId, amount, goodsName} | null, returnUrl }.
// window가 있으면 나이스페이 결제창(AUTHNICE.requestPay)에 그대로 넘긴다. null이면 결제창을 다시 열지 않고 진행 화면(jobId)에서 결과를 본다.
// 나이스페이 키가 없으면 503 payment_not_ready(돈이 움직이는 경로를 열지 않음). 실행은 서버가 승인을 확인한 뒤에만 시작된다.
const NOT_READY = { error: "payment_not_ready", message: "결제 준비 중입니다. 잠시 후 다시 시도해 주십시오" };

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const gw = paymentGateway();
  const origin = requestOrigin(req.headers);
  if (!gw || !origin) return noStore(NextResponse.json(NOT_READY, { status: 503 }));
  const body = await readJson<{ consent: unknown; shopUrl: unknown }>(req);
  const r = await startOneTimeCardPurchase(prisma, gw, ctx, { idempotencyKey: req.headers.get("idempotency-key"), consent: body.consent, shopUrl: body.shopUrl });
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, ...(r.reason === "shop_not_supported" ? { message: SHOP_NOT_SUPPORTED_MESSAGE } : {}), ...(r.jobId ? { jobId: r.jobId } : {}) }, { status: PURCHASE_FAILURE_STATUS[r.reason] }));
  return noStore(NextResponse.json({ ...r, returnUrl: new URL("/api/automation/purchase/one-time/return", origin).toString() }, { status: r.replayed ? 200 : 201 }));
});
