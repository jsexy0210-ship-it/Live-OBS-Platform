import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { AUTOMATION_MESSAGES, readShippingAutomation, updateShippingAutomation } from "../../../../lib/server/sellers/shippingAutomation";

// 배송 자동화(SA-082, 「쇼핑몰 설정」 권한, 쇼핑몰 통합 요금제). 계약은 lib/server/sellers/shippingAutomation.ts 머리말.
// GET → { features: [{ feature: invoiceIssue|invoiceLabel|deliveryTracking|returnInvoice, enabled, unitPrice(원, 마스터 관리자 단가), monthCount, monthAmount(이번 달 KST) }],
//        enabledCount, monthCount, monthAmount, balance(발송·이용 충전금 잔액), chargingEnabled, shortage: [켜 둔 기능 중 충전금 부족으로 멈춘 것] }
// PUT { invoiceIssue?, invoiceLabel?, deliveryTracking?, returnInvoice? }(boolean, 빼면 지금 값 유지) → GET과 같은 모양. 하나도 없거나 boolean이 아니면 400 invalid_automation.
// 배송 자동 조회는 주문 정책 autoTrackingEnabled와 같은 값이다. 요금제가 지원하지 않으면 403 plan_feature_required, 「쇼핑몰 설정」 권한이 없는 직원은 403 forbidden.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json(await readShippingAutomation(prisma, ctx), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateShippingAutomation(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: AUTOMATION_MESSAGES[r.reason] }, { status: 400, headers: { "cache-control": "no-store" } });
  const { ok: _ok, ...body } = r;
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
});
