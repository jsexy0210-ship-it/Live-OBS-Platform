import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { cancelPendingOrder } from "../../../../../../lib/server/queue/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 결제 대기 주문 취소. 사유·expectedVersion(화면이 받은 version) 필수, ORDER_SHIPPING 권한.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: string; expectedVersion: number }>(req);
  if (!Number.isInteger(body.expectedVersion)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await cancelPendingOrder(prisma, ctx, orderId, {
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
    expectedLiveVersion: body.expectedVersion as number,
  });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ ...result.value, version: result.version });
});
