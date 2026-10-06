import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { INVOICE_MESSAGES, invoiceStatus, planInvoices } from "../../../../../lib/server/invoices/service";

// 발급 전 확인(SA-027 2단계 「합배송 · 주소 확인」, ORDER_SHIPPING): 본문 { orderIds, bundle? }. 아무것도 바꾸지 않는다(그래서 읽기 요청이지만 본문을 받으려 POST).
// rows(주문별 묶음 번호 groupNo·묶음 건수·주소 확인 addressIssue: zip_missing·address_missing·받는 분 정보는 개인정보 권한이 있을 때만), rejected(보낼 수 없는 주문), summary(발급할 송장·주문·주소 확인 건수).
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await planInvoices(prisma, ctx, await readJson<{ orderIds: unknown; bundle: unknown }>(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
  const { ok: _ok, ...body } = r;
  return noStore(NextResponse.json(body));
});
