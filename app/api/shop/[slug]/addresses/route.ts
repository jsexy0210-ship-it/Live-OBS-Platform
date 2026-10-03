import { NextResponse } from "next/server";
import { createAddress, listAddresses } from "../../../../../lib/server/buyers/addresses";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";

// 구매자 저장 배송지(마이페이지·주문서). 응답 { addresses }: 기본 배송지 먼저, 그다음 최근 저장 순.
// 잠긴 쇼핑몰이어도 본인 배송지 조회·정리는 연다. 개인 정보라 캐시하지 않는다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    return noStore(NextResponse.json({ addresses: await listAddresses(prisma, b.scope) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 추가. 본문: { recipientName, phone, zipCode, address1, address2?, memo?, label?(20자), isDefault? }
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await createAddress(prisma, b.scope, await readJson(req));
  if (!r.ok) return noStore(NextResponse.json(orderErrorBody(r.reason), { status: r.reason === "invalid_shipping_address" || r.reason === "invalid_address_label" ? 400 : 409 }));
  return noStore(NextResponse.json({ address: r.value }, { status: 201 }));
});
