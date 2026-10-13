import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { INVOICE_MESSAGES, invoiceStatus, issueInvoices, listInvoices } from "../../../../lib/server/invoices/service";

// 송장 출력·추적 목록(SA-028, ORDER_SHIPPING). 쿼리: status(FAILED·ISSUED·PRINTED·PICKED_UP·DELIVERED)·q(송장번호·닉네임)·cursor·limit(기본 30, 최대 100).
// 응답: invoices(상태·마지막 추적·집하 지연 pickupDelayed·발급 중 issuing), counts(상태별)·total·unprinted, mock(업체 연동 전 모의 안내). 열 때마다 출력한 송장의 추적을 동기화한다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await listInvoices(prisma, ctx, { status: p.get("status"), q: p.get("q"), cursor: p.get("cursor"), limit: p.get("limit") });
  if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return errorResponse(e);
  }
}

// 송장 발급(SA-027, 모의 발급). 본문 { orderIds: string[](1~100), bundle?: boolean(같은 받는 분 합배송 묶기 확인), courier?: 택배사 코드(생략하면 배송 설정의 기본 택배사) }.
// 묶음마다 따로 처리해 { results: [{ orderIds, invoiceId, ok, trackingNumber?, reason? }], skipped(주소 확인 필요·보낼 수 없는 주문), issued, failed }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await issueInvoices(prisma, ctx, await readJson<{ orderIds: unknown; bundle: unknown; courier: unknown }>(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: INVOICE_MESSAGES[r.reason] }, { status: invoiceStatus(r.reason) });
  const { ok: _ok, ...body } = r;
  return noStore(NextResponse.json(body));
});
