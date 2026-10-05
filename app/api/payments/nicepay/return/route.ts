import { NextResponse } from "next/server";
import { requestOrigin } from "../../../../../lib/server/branding/siteUrl";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../lib/server/http/route";
import type { AuthResult } from "../../../../../lib/server/payments/gateway";
import { paymentGateway } from "../../../../../lib/server/payments/registry";
import { confirmAuthResult } from "../../../../../lib/server/payments/service";

// 나이스페이 결제 창 인증 결과(returnUrl, application/x-www-form-urlencoded POST). PG 페이지에서 넘어오므로 Origin 검사·세션 쿠키 없이
// 서명(authToken·clientId·amount·비밀키)과 결제 행으로만 판단한다. 승인까지 마친 뒤 구매자 주문 화면으로 보낸다(?orderId=…&payment=paid|failed|pending|cancelled).
const FIELDS = ["authResultCode", "authResultMsg", "tid", "clientId", "orderId", "amount", "authToken", "signature"] as const;

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
    // 인증 결과 수신 로그(콘솔): 어떤 필드가 왔는지(이름만)와 코드·문구. 값이 비어 있거나 모르는 필드가 오는 문제를 진단한다. 카드·개인정보 값은 남기지 않는다.
    if (r.authResultCode !== "0000") console.warn("[payments] return received", JSON.stringify({ fields: [...new Set(form.keys())].slice(0, 30), code: r.authResultCode.slice(0, 20), message: (r.authResultMsg ?? "").slice(0, 100) }));
    const out = await confirmAuthResult(prisma, gw, r);
    if (!out.ok) return noStore(new NextResponse(out.reason, { status: out.reason === "not_found" ? 404 : 400 }));
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: out.sellerId }, select: { slug: true } });
    const path = `/shop/${encodeURIComponent(seller.slug)}/orders?orderId=${out.orderId}&payment=${out.outcome}`;
    // 요청 주소(req.url)는 리버스 프록시 뒤에서 내부 주소(0.0.0.0:3000)라 공개 주소는 Host·신뢰 프록시 헤더로 만든다(못 만들 때만 요청 주소).
    return noStore(NextResponse.redirect(new URL(path, requestOrigin(req.headers) ?? req.url), 303));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
