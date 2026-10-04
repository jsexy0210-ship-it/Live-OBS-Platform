import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { noStore } from "../../../../../lib/server/http/route";
import { paymentGateway } from "../../../../../lib/server/payments/registry";
import { handleWebhook } from "../../../../../lib/server/payments/service";

// 나이스페이 웹훅(JSON). 서명(tid·amount·ediDate·비밀키)이 맞으면 PG 조회로 결제를 확정한다(본문 값은 믿지 않음).
// 나이스페이는 본문이 정확히 "OK"(200, text/html)여야 받은 것으로 본다. 처리 중 오류는 500으로 돌려 재전송을 받는다.
const ok = () => noStore(new NextResponse("OK", { status: 200, headers: { "Content-Type": "text/html;charset=utf-8" } }));

export async function POST(req: Request) {
  const gw = paymentGateway();
  if (!gw) return noStore(new NextResponse("payment_not_ready", { status: 503 }));
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noStore(new NextResponse("bad_request", { status: 400 }));
  }
  try {
    const r = await handleWebhook(prisma, gw, body);
    return r === "ok" ? ok() : noStore(new NextResponse("invalid_signature", { status: 401 }));
  } catch (e) {
    console.error("[payments] webhook failed", e instanceof Error ? e.message : "error");
    return noStore(new NextResponse("error", { status: 500 }));
  }
}
