import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { paymentErrorBody, startPaymentStatus } from "../../../../../lib/server/payments/messages";
import { paymentGateway } from "../../../../../lib/server/payments/registry";
import { startPayment } from "../../../../../lib/server/payments/service";

// 구매자 주문 카드 결제 시작(나이스페이 테스트 결제). 본문 { orderId }. 금액은 서버가 주문으로 다시 계산한다(본문 금액은 받지 않음).
// 응답은 결제 창(나이스페이 JS SDK AUTHNICE.requestPay)에 넘길 값: { paymentId, clientId, method, orderId(결제 시도 번호), amount, goodsName, returnUrl }과
// 남은 기한 표시용 paymentDueAt(주문할 때 정한 기한, 지나면 주문이 자동 취소되고 승인 중이던 카드 결제는 전액 취소).
// 나이스페이 키가 서버에 없으면 503 payment_not_ready. 실패 응답은 { error, message(화면 문구) }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller) return noStore(NextResponse.json(paymentErrorBody("not_found"), { status: 404 }));
  const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
  if (!session) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
  const gw = paymentGateway();
  if (!gw) return noStore(NextResponse.json(paymentErrorBody("payment_not_ready"), { status: 503 }));
  const body = await readJson<{ orderId: unknown }>(req);
  if (typeof body.orderId !== "string") return noStore(NextResponse.json(paymentErrorBody("invalid_request"), { status: 400 }));
  const r = await startPayment(prisma, gw, { sellerId: seller.id, buyerMemberId: session.member.id, orderId: body.orderId });
  if (!r.ok) return noStore(NextResponse.json(paymentErrorBody(r.reason), { status: startPaymentStatus(r.reason) }));
  const { ok: _ok, ...value } = r;
  return noStore(NextResponse.json({ ...value, returnUrl: new URL("/api/payments/nicepay/return", req.url).toString() }));
});
