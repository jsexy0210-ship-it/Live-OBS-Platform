import type { ActorType, Prisma, ReturnKind, ReturnStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { ACTIVE_STATUSES } from "./rules";
import { returnImageStore } from "./store";

// 기존 주문 파일(queue/service.ts 환불, orders/delivery.ts 자동 구매 확정)이 부르는 연결 함수. service.ts와 순환하지 않게 따로 둔다.
type Tx = Prisma.TransactionClient;

// 환불이 일어난 주문의 진행 중인 신청을 닫는다(refundOrder의 같은 트랜잭션에서 주문 행을 잡은 뒤 부른다).
// 반품 회수 완료분은 환불로 완료, 그 밖의 신청(신청·접수 단계, 회수 완료한 교환)은 철회로 닫는다.
export async function closeReturnsOnRefund(tx: Tx, o: { sellerId: string; orderId: string; refundAmount: number; now: Date; actor: { actorType: ActorType; actorId: string | null } }) {
  const rows = await tx.$queryRaw<{ id: string; kind: ReturnKind; status: ReturnStatus }[]>`
    SELECT "id", "kind"::text AS "kind", "status"::text AS "status" FROM "ReturnRequest"
    WHERE "orderId" = ${o.orderId}::uuid AND "sellerId" = ${o.sellerId}::uuid AND "status" IN ('REQUESTED', 'ACCEPTED', 'RECEIVED') FOR UPDATE`;
  for (const r of rows) {
    const done = r.kind === "RETURN" && r.status === "RECEIVED";
    await tx.returnRequest.update({
      where: { id: r.id },
      data: done ? { status: "COMPLETED", completedAt: o.now, refundAmount: o.refundAmount, updatedAt: o.now } : { status: "CANCELLED", cancelledAt: o.now, updatedAt: o.now },
    });
    await writeAudit(tx, { ...o.actor, sellerId: o.sellerId, action: done ? "return.refund" : "return.close_on_refund", targetType: "ReturnRequest", targetId: r.id, before: { status: r.status }, after: { status: done ? "COMPLETED" : "CANCELLED", refundAmount: done ? o.refundAmount : undefined } });
  }
  return rows.length;
}

// 진행 중인 신청이 있는 주문인지(자동 구매 확정이 확정하지 않는다)
export async function hasActiveReturn(tx: Tx, sellerId: string, orderId: string): Promise<boolean> {
  return (await tx.returnRequest.count({ where: { sellerId, orderId, status: { in: [...ACTIVE_STATUSES] } } })) > 0;
}

// 탈퇴 회원의 신청에 붙지 않은 사진 삭제
export async function deleteUnattachedReturnImages(tx: Tx, scope: { sellerId: string; buyerMemberId: string }): Promise<number> {
  return returnImageStore.delete(tx, { ...scope, returnRequestId: null });
}
