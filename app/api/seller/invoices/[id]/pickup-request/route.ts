import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { INVOICE_MESSAGES, invoiceStatus, requestInvoicePickup } from "../../../../../../lib/server/invoices/service";

// 집하 요청 다시 보내기(SA-028, ORDER_SHIPPING): 출력했지만 아직 집하되지 않은 송장만. 어댑터가 받으면 「집하 요청」 이벤트를 남긴다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await requestInvoicePickup(prisma, ctx, (await params).id);
  if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
  return noStore(NextResponse.json({ ok: true }));
});
