import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { INVOICE_MESSAGES, invoiceStatus, printInvoices } from "../../../../../lib/server/invoices/service";

// 송장 출력(SA-028, ORDER_SHIPPING): 본문 { format: "LABEL_100X150" | "A4_2UP", invoiceIds?: string[](생략하면 아직 출력하지 않은 송장 전부, 최대 100) }.
// 발급됨 → 출력됨으로 바꾸고 라벨 자료 labels를 준다. 이미 출력한 송장은 라벨만 다시(reprint). 받는 분 정보는 개인정보 권한이 있을 때만.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await printInvoices(prisma, ctx, await readJson<{ format: unknown; invoiceIds: unknown }>(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
  const { ok: _ok, ...body } = r;
  return noStore(NextResponse.json(body));
});
