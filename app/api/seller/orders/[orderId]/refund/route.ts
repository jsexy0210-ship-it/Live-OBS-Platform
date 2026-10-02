import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { refundOrder } from "../../../../../../lib/server/queue/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 결제 완료 주문 환불(개봉 전 품목만 재고 복구, 연결된 대기·개봉 중 자동 취소). 사유 필수, ORDER_SHIPPING 권한.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: string }>(req);
  const result = await refundOrder(prisma, ctx, orderId, { reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ ...result.value, version: result.version });
});
