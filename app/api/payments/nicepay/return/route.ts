import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../lib/server/http/route";
import type { AuthResult } from "../../../../../lib/server/payments/gateway";
import { paymentGateway } from "../../../../../lib/server/payments/registry";
import { confirmAuthResult } from "../../../../../lib/server/payments/service";

// 나이스페이 결제 창 인증 결과(returnUrl, application/x-www-form-urlencoded POST). PG 페이지에서 넘어오므로 Origin 검사·세션 쿠키 없이
// 서명(authToken·clientId·amount·비밀키)과 결제 행으로만 판단한다. 승인까지 마친 뒤 구매자 주문 화면으로 보낸다(?orderId=…&payment=paid|failed|pending|cancelled).
const FIELDS = ["authResultCode", "tid", "clientId", "orderId", "amount", "authToken", "signature"] as const;

export async function POST(req: Request) {
  try {
    const gw = paymentGateway();
    if (!gw) return noStore(new NextResponse("payment_not_ready", { status: 503 }));
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return noStore(new NextResponse("bad_request", { status: 400 }));
    }
    const r = Object.fromEntries(FIELDS.map((k) => [k, String(form.get(k) ?? "").slice(0, 300)])) as AuthResult;
    const out = await confirmAuthResult(prisma, gw, r);
    if (!out.ok) return noStore(new NextResponse(out.reason, { status: out.reason === "not_found" ? 404 : 400 }));
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: out.sellerId }, select: { slug: true } });
    const to = new URL(`/shop/${encodeURIComponent(seller.slug)}/orders?orderId=${out.orderId}&payment=${out.outcome}`, req.url);
    return noStore(NextResponse.redirect(to, 303));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
