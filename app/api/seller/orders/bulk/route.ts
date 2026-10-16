import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { INVOICE_MESSAGES, invoiceStatus, issueInvoices } from "../../../../../lib/server/invoices/service";
import { prepareShipping } from "../../../../../lib/server/orders/bulk";

// 주문 목록 선택 일괄(SA-021, ORDER_SHIPPING). 본문 { action, orderIds: string[](1~100), ... }.
// - action "prepare_shipping"(배송 준비로 변경): 개봉 완료 주문만 바뀌고 나머지는 건너뜀. 응답 { results: [{ orderId, ok, reason? }], prepared }. reason: not_found·not_paid·not_ready·already_shipped·already_prepared·not_opened.
// - action "issue_invoices"(송장 일괄 입력): 모의 송장 발급(POST /api/seller/invoices와 같음). 추가 본문 { bundle?: boolean, courier?: 택배사 코드 }. 응답은 그 API와 같다.
// 잘못된 본문·모르는 action은 400 bad_request.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const body = await readJson<{ action: unknown; orderIds: unknown; bundle: unknown; courier: unknown }>(req);
  if (body.action === "prepare_shipping") {
    const r = await prepareShipping(prisma, ctx, body.orderIds);
    if (!r.ok) return NextResponse.json({ error: "bad_request", message: "요청을 확인해 주십시오" }, { status: 400 });
    return noStore(NextResponse.json({ results: r.results, prepared: r.prepared }));
  }
  if (body.action === "issue_invoices") {
    const r = await issueInvoices(prisma, ctx, { orderIds: body.orderIds, bundle: body.bundle, courier: body.courier });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
    const { ok: _ok, ...rest } = r;
    return noStore(NextResponse.json(rest));
  }
  return NextResponse.json({ error: "bad_request", message: "요청을 확인해 주십시오" }, { status: 400 });
});
