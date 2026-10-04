import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { confirmDeposits } from "../../../../../../lib/server/payments/bank";
import { sellerPaymentErrorBody } from "../../../../../../lib/server/payments/messages";

// 입금 확인(단건·일괄, ORDER_SHIPPING). 본문 { orderIds: [주문 id 1~50개], expectedVersion(판매자 liveVersion) }.
// 응답 { results: [{ orderId, result: paid|stock_shortage|already_paid|card_in_progress|not_payable|not_found }] }.
// 버전이 다르면 409 conflict(아무것도 바꾸지 않음), 값이 틀리면 400 invalid_request. 잠긴 쇼핑몰도 이미 받은 주문은 처리한다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const body = await readJson<{ orderIds: unknown; expectedVersion: unknown }>(req);
  const r = await confirmDeposits(prisma, ctx, { orderIds: body.orderIds, expectedVersion: body.expectedVersion });
  if (!r.ok) return NextResponse.json(sellerPaymentErrorBody(r.reason), { status: r.reason === "conflict" ? 409 : 400 });
  return NextResponse.json({ results: r.results });
});
