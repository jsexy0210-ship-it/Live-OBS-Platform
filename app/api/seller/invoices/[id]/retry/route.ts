import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { INVOICE_MESSAGES, invoiceStatus, retryInvoice } from "../../../../../../lib/server/invoices/service";

// 실패 건 다시 발급(SA-027, ORDER_SHIPPING): 번호가 없는(FAILED) 송장만, 발급 중(5분 안)이면 409. 결과 { result: { orderIds, invoiceId, ok, trackingNumber?, reason? } }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await retryInvoice(prisma, ctx, (await params).id);
  if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
  return noStore(NextResponse.json({ result: r.result }));
});
