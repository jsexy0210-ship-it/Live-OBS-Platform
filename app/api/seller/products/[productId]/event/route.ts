import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { clearProductEvent, setProductEvent } from "../../../../../../lib/server/products/event";

type Ctx = { params: Promise<{ productId: string }> };

// 상품 이벤트 할인 설정(PRODUCT_MANAGE). 본문 { type: "RATE"(할인율 1~90%) | "AMOUNT"(할인 금액 원), value, startsAt, endsAt(ISO) }.
// 응답 { event }: 진행 중 여부·할인가·「오늘 마감」/「D-n」 배지·남은 시간. 할인 뒤 단가가 1원 미만이 되는 옵션이 있으면 400.
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await setProductEvent(prisma, ctx, (await params).productId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json({ event: r.value });
});

// 이벤트 할인 끄기. 이미 만든 주문 금액은 그대로다.
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  await clearProductEvent(prisma, ctx, (await params).productId);
  return NextResponse.json({ ok: true });
});
