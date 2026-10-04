import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../../lib/server/billing/registry";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { chargeMessageBalance, listMessageCharges } from "../../../../../lib/server/messaging/charge";

const MESSAGES = {
  invalid_charge: { status: 400, message: "충전 금액은 1,000원에서 100만 원 사이, 1,000원 단위로 입력해 주십시오" },
  charging_disabled: { status: 403, message: "지금은 충전할 수 없습니다" },
  consent_required: { status: 409, message: "발송 비용 안내를 확인하고 동의해 주십시오" },
  card_required: { status: 409, message: "구독 결제 카드를 먼저 등록해 주십시오" },
} as const;

// 충전 내역(최근 20건)과 잔액(대표자 전용)
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return NextResponse.json(await listMessageCharges(prisma, ctx), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 충전(구독 결제 카드). 본문 { amount, idempotencyKey }. 결제 완료 200, 확인 중 202(같은 키로 다시 보내면 결과 확인), 결제 실패 402.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const body = await readJson<{ amount?: unknown; idempotencyKey?: unknown }>(req);
  const r = await chargeMessageBalance(prisma, billingProvider(), ctx, body);
  if (!r.ok) return NextResponse.json({ error: r.reason, message: MESSAGES[r.reason].message }, { status: MESSAGES[r.reason].status });
  const status = r.charge.status === "PAID" ? 200 : r.charge.status === "PENDING" ? 202 : 402;
  const message = r.charge.status === "FAILED" ? { message: "카드 결제가 되지 않았습니다. 카드를 확인해 주십시오" } : {};
  return NextResponse.json({ charge: r.charge, ...message }, { status });
});
