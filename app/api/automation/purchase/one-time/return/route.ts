import { NextResponse } from "next/server";
import { confirmOneTimeAuthResult } from "../../../../../../lib/server/automation/purchase";
import { requestOrigin } from "../../../../../../lib/server/branding/siteUrl";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../../lib/server/http/route";
import type { AuthResult } from "../../../../../../lib/server/payments/gateway";
import { paymentGateway } from "../../../../../../lib/server/payments/registry";

// 자동 연결 「다른 카드로 결제」 결제창 인증 결과(returnUrl, form POST). PG 페이지에서 넘어오므로 세션 쿠키·Origin 검사 없이 서명과 결제 행으로만 판단한다.
// 서버 승인까지 마친 뒤 화면으로 보낸다: 결제됨·확인 중 → 진행 화면 /seller/automation/{jobId}(?payment=paid|pending), 실패 → 결제 화면 /seller/automation/pay?shop=…&payment=failed.
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
    const out = await confirmOneTimeAuthResult(prisma, gw, r);
    if (!out.ok) return noStore(new NextResponse(out.reason, { status: out.reason === "not_found" ? 404 : 400 }));
    const path =
      out.outcome !== "failed" && out.jobId
        ? `/seller/automation/${out.jobId}?payment=${out.outcome}`
        : `/seller/automation/pay?${new URLSearchParams({ ...(out.shopHost ? { shop: `https://${out.shopHost}` } : {}), payment: "failed" })}`;
    return noStore(NextResponse.redirect(new URL(path, requestOrigin(req.headers) ?? req.url), 303));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
