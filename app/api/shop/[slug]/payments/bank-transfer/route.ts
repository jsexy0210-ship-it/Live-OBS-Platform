import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../../lib/server/auth/session";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { chooseBankTransfer } from "../../../../../../lib/server/payments/bank";
import { BANK_TRANSFER_MESSAGES, bankTransferStatus, paymentErrorBody } from "../../../../../../lib/server/payments/messages";

// 구매자 무통장 입금 선택·안내. 본문 { orderId }. 주문 결제수단을 무통장 입금으로 정하고
// { orderId, amount, bankName, accountNumber, accountHolder, paymentDueAt }를 준다(다시 불러도 같은 안내, 입금 기한은 주문할 때 값 그대로).
// 실패 응답은 { error, message(화면 문구) }: 402 shop_unavailable, 404 not_found, 409 order_not_payable·already_paid·amount_mismatch·bank_account_missing.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller) return noStore(NextResponse.json(paymentErrorBody("not_found"), { status: 404 }));
  const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
  if (!session) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
  const body = await readJson<{ orderId: unknown }>(req);
  if (typeof body.orderId !== "string") return noStore(NextResponse.json(paymentErrorBody("invalid_request"), { status: 400 }));
  const r = await chooseBankTransfer(prisma, { sellerId: seller.id, buyerMemberId: session.member.id, orderId: body.orderId });
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BANK_TRANSFER_MESSAGES[r.reason] }, { status: bankTransferStatus(r.reason) }));
  return noStore(NextResponse.json(r.value));
});
