import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../lib/server/http/route";
import { buyerReceiptContext, createReceiptRequest, receiptError } from "../../../../../lib/server/receipts/service";

// 이 주문의 현금영수증·세금계산서 신청 정보(SH-005·SH-022): 신청 가능 여부(blocked 이유), 진행 중인 신청(active)과 지난 신청. ?orderId 필수. 남의 주문은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const ctx = await buyerReceiptContext(prisma, b.scope, new URL(req.url).searchParams.get("orderId") ?? "");
  return noStore(ctx ? NextResponse.json(ctx) : NextResponse.json({ error: "not_found" }, { status: 404 }));
}

// 신청. body { orderId, kind(CASH_RECEIPT_INCOME·CASH_RECEIPT_EXPENSE·TAX_INVOICE), identity(소득공제 휴대폰 / 지출증빙·세금계산서 사업자등록번호), taxInfo?: { companyName, representative, email }(세금계산서 필수) }.
// 무통장·계좌이체 주문의 입금 전·결제 완료만(409 not_requestable), 이미 신청했으면 409 active_exists, 잘못된 번호 400 invalid_identity.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<Record<string, unknown>>(req);
  const r = await createReceiptRequest(prisma, b.scope, typeof body.orderId === "string" ? body.orderId : "", body, requestMeta(req));
  if (!r.ok) {
    const e = receiptError(r.reason, "buyer");
    return noStore(NextResponse.json(e.body, { status: e.status }));
  }
  return noStore(NextResponse.json({ request: r.request }, { status: 201 }));
});
