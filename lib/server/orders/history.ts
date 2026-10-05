import type { ActorType, OrderStatus, PaymentCancelStatus, PrismaClient } from "@prisma/client";
import type { TenantContext } from "../tenant/context";

// SA-022 파트너스 주문 상세의 「상태 이력」(GET /api/seller/orders/{id}의 history). 시각 오름차순.
// 호출하는 쪽이 getOrder로 판매자 범위·ORDER_SHIPPING 권한·주문 존재를 이미 확인했다. 여기서도 모든 조회에 sellerId를 건다.
// 처리자는 역할·이름 수준만 준다(구매자·마스터 관리자는 이름 없이 역할만, 파트너스 직원은 직원 이름, 이메일·id는 주지 않는다).
export type OrderHistoryEvent = {
  // status: 주문 상태 변경(결제 완료·취소·환불 완료 등) / payment_approved: PG 결제 승인 /
  // refund_partial: 일부 품목 환불 / payment_cancel: PG 결제 취소(전체·부분 모두, 결과는 cancelStatus)
  kind: "status" | "payment_approved" | "refund_partial" | "payment_cancel";
  at: string;
  // status일 때만: 바뀐 뒤 주문 상태(fromStatus는 이전 상태)
  status: OrderStatus | null;
  fromStatus: OrderStatus | null;
  // 금액(원): payment_approved·refund_partial·payment_cancel
  amount: number | null;
  // refund_partial일 때 환불한 수량 합
  quantity: number | null;
  // payment_cancel일 때만: REQUESTED(보냄 대기)·DONE(취소됨)·FAILED(실패, 다시 보냄)
  cancelStatus: PaymentCancelStatus | null;
  actor: { type: "SELLER" | "BUYER" | "ADMIN" | "SYSTEM"; role: "OWNER" | "STAFF" | null; name: string | null };
  // 사유·비고(파트너스가 쓴 환불 사유 등). 없으면 null
  note: string | null;
};

const ACTOR_TYPE: Record<ActorType, OrderHistoryEvent["actor"]["type"]> = { SELLER_USER: "SELLER", BUYER: "BUYER", PLATFORM_ADMIN: "ADMIN", SYSTEM: "SYSTEM" };
const KIND_ORDER: Record<OrderHistoryEvent["kind"], number> = { status: 0, payment_approved: 1, refund_partial: 2, payment_cancel: 3 };

export async function getOrderHistory(db: PrismaClient, ctx: TenantContext, orderId: string): Promise<OrderHistoryEvent[]> {
  const sellerId = ctx.sellerId;
  const [statuses, payments, partials] = await Promise.all([
    db.orderStatusHistory.findMany({ where: { sellerId, orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.payment.findMany({ where: { sellerId, orderId }, include: { cancels: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.auditLog.findMany({ where: { sellerId, action: "order.refund_partial", targetType: "Order", targetId: orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);

  const staffIds = [...new Set([...statuses, ...partials].filter((r) => r.actorType === "SELLER_USER" && r.actorId).map((r) => r.actorId as string))];
  const staff = staffIds.length ? await db.sellerUser.findMany({ where: { sellerId, id: { in: staffIds } }, select: { id: true, name: true, isOwner: true } }) : [];
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const actorOf = (type: ActorType, id: string | null): OrderHistoryEvent["actor"] => {
    const s = type === "SELLER_USER" && id ? staffById.get(id) : undefined;
    return { type: ACTOR_TYPE[type], role: type === "SELLER_USER" ? (s?.isOwner ? "OWNER" : "STAFF") : null, name: s?.name ?? null };
  };
  const base = { status: null, fromStatus: null, amount: null, quantity: null, cancelStatus: null, note: null } as const;
  const system = actorOf("SYSTEM", null);

  const events: OrderHistoryEvent[] = [];
  for (const h of statuses) {
    events.push({ ...base, kind: "status", at: h.createdAt.toISOString(), status: h.toStatus, fromStatus: h.fromStatus, actor: actorOf(h.actorType, h.actorId), note: h.reason });
  }
  for (const p of payments) {
    if (p.approvedAt) events.push({ ...base, kind: "payment_approved", at: p.approvedAt.toISOString(), amount: p.amount, actor: system });
    for (const c of p.cancels) {
      // 취소가 끝났으면 끝난 시각, 아직이거나 실패면 요청한 시각
      const at = c.status === "DONE" && c.doneAt ? c.doneAt : c.createdAt;
      events.push({ ...base, kind: "payment_cancel", at: at.toISOString(), amount: c.amount, cancelStatus: c.status, actor: system, note: c.reason });
    }
  }
  for (const a of partials) {
    const after = (a.after ?? {}) as { refundAmount?: unknown; items?: unknown };
    const lines = Array.isArray(after.items) ? (after.items as { quantity?: unknown }[]) : [];
    events.push({
      ...base,
      kind: "refund_partial",
      at: a.createdAt.toISOString(),
      amount: typeof after.refundAmount === "number" ? after.refundAmount : null,
      quantity: lines.reduce((n, l) => n + (typeof l.quantity === "number" ? l.quantity : 0), 0),
      actor: actorOf(a.actorType, a.actorId),
      note: a.reason,
    });
  }
  return events.sort((x, y) => x.at.localeCompare(y.at) || KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
}
