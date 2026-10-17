import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { getOrderMemo, putOrderMemo } from "../../../../../../lib/server/orders/memo";

// 주문 메모(SA-021 「메모 남기기」, ORDER_SHIPPING). 잠금 중에도 이미 받은 주문은 처리할 수 있다(주문 상세와 같은 기준).
// GET → { memo: { body, createdAt, updatedAt, updatedBy: { name } | null } | null }. 없는·다른 쇼핑몰 주문은 404.
export async function GET(req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return noStore(NextResponse.json({ memo: await getOrderMemo(prisma, ctx, (await params).orderId) }));
  } catch (e) {
    return errorResponse(e);
  }
}

// PUT 본문: { body: string(1,000자 이하, 줄바꿈 허용) }. 빈 글이면 메모를 지우고 { memo: null }. 글자가 잘못되면 400 invalid_memo.
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const b = await readJson<{ body: unknown }>(req);
  const r = await putOrderMemo(prisma, ctx, (await params).orderId, b.body);
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return noStore(NextResponse.json({ memo: r.memo }));
});
