import type { ActorType, Prisma } from "@prisma/client";
import { writeAudit } from "../audit/log";

// 환불(queue/service.ts refundOrder)이 같은 트랜잭션에서 부르는 연결 함수. refundRequest.ts와 순환하지 않게 따로 둔다.
type Tx = Prisma.TransactionClient;

// 환불이 생긴 주문의 구매자 환불 요청을 닫는다(주문 행을 잡은 뒤 부른다. 잠금 순서: 주문 → 요청).
// - requestId(요청 승인으로 한 환불): 그 요청이 아직 진행 중이어야 한다. 아니면 false(부르는 쪽이 트랜잭션을 되돌린다).
// - requestId 없이 남은 품목을 모두 돌려준 환불(isFinal): 진행 중인 요청은 바라던 환불이 끝났으니 승인으로 닫는다.
export async function settleRefundRequestsOnRefund(
  tx: Tx,
  o: { sellerId: string; orderId: string; refundId: string; isFinal: boolean; requestId?: string; now: Date; actor: { actorType: ActorType; actorId: string | null } },
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "RefundRequest"
    WHERE "orderId" = ${o.orderId}::uuid AND "sellerId" = ${o.sellerId}::uuid AND "status" = 'REQUESTED' FOR UPDATE`;
  if (o.requestId && !rows.some((r) => r.id === o.requestId)) return false;
  const close = o.requestId ? rows.filter((r) => r.id === o.requestId) : o.isFinal ? rows : [];
  for (const r of close) {
    await tx.refundRequest.update({ where: { id: r.id }, data: { status: "APPROVED", refundId: o.refundId, decidedAt: o.now } });
    await writeAudit(tx, {
      ...o.actor,
      sellerId: o.sellerId,
      action: o.requestId ? "refund_request.approve" : "refund_request.close_on_refund",
      targetType: "RefundRequest",
      targetId: r.id,
      before: { status: "REQUESTED" },
      after: { status: "APPROVED", refundId: o.refundId },
    });
  }
  return true;
}
