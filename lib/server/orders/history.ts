import type { ActorType, OrderStatus, PaymentCancelStatus, PrismaClient } from "@prisma/client";
import { SANDBOX_PARTIAL_CANCEL_MESSAGE } from "../payments/messages";
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
  // payment_cancel일 때만: REQUESTED(보냄 대기)·DONE(취소됨)·FAILED(결제사가 거절, 자동으로 다시 보내지 않음)
  cancelStatus: PaymentCancelStatus | null;
  // payment_cancel이 FAILED일 때만: 결제사 거절 코드(우리 코드 over_balance·provider_mismatch, 나이스페이 nicepay_{결과코드}). 카드번호 등은 없다.
  failureCode: string | null;
  actor: { type: "SELLER" | "BUYER" | "ADMIN" | "SYSTEM"; role: "OWNER" | "STAFF" | null; name: string | null };
  // 사유·비고(파트너스가 쓴 환불 사유 등). 취소가 FAILED면 사람이 읽을 실패 사유(합니다체, 결제사가 준 문구가 있으면 괄호로 덧붙임). 없으면 null
  note: string | null;
};

// 결제 취소 실패 코드 → 파트너스·마스터 화면 문구(합니다체). 모르는 코드는 일반 문구.
const CANCEL_FAILURE_MESSAGES: Record<string, string> = {
  nicepay_U128: SANDBOX_PARTIAL_CANCEL_MESSAGE,
  over_balance: "취소할 금액이 남은 결제 금액보다 큽니다",
  provider_mismatch: "다른 결제사로 받은 결제라 취소할 수 없습니다",
};
export function cancelFailureText(code: string | null, pgMessage?: string | null): string {
  const known = code ? CANCEL_FAILURE_MESSAGES[code] : undefined;
  if (known) return known;
  const base = code?.startsWith("nicepay_") ? "결제사에서 취소를 거절했습니다" : "결제 취소가 끝나지 않았습니다";
  return pgMessage ? `${base}(${pgMessage})` : base;
}

const ACTOR_TYPE: Record<ActorType, OrderHistoryEvent["actor"]["type"]> = { SELLER_USER: "SELLER", BUYER: "BUYER", PLATFORM_ADMIN: "ADMIN", SYSTEM: "SYSTEM" };
const KIND_ORDER: Record<OrderHistoryEvent["kind"], number> = { status: 0, payment_approved: 1, refund_partial: 2, payment_cancel: 3 };

export async function getOrderHistory(db: PrismaClient, ctx: TenantContext, orderId: string): Promise<OrderHistoryEvent[]> {
  const sellerId = ctx.sellerId;
  const [statuses, payments, partials, cancelFailures] = await Promise.all([
    db.orderStatusHistory.findMany({ where: { sellerId, orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.payment.findMany({ where: { sellerId, orderId }, include: { cancels: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.auditLog.findMany({ where: { sellerId, action: "order.refund_partial", targetType: "Order", targetId: orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.auditLog.findMany({ where: { sellerId, action: "payment.cancel_failed", targetType: "Order", targetId: orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);

  const staffIds = [...new Set([...statuses, ...partials].filter((r) => r.actorType === "SELLER_USER" && r.actorId).map((r) => r.actorId as string))];
  const staff = staffIds.length ? await db.sellerUser.findMany({ where: { sellerId, id: { in: staffIds } }, select: { id: true, name: true, isOwner: true } }) : [];
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const actorOf = (type: ActorType, id: string | null): OrderHistoryEvent["actor"] => {
    const s = type === "SELLER_USER" && id ? staffById.get(id) : undefined;
    return { type: ACTOR_TYPE[type], role: type === "SELLER_USER" ? (s?.isOwner ? "OWNER" : "STAFF") : null, name: s?.name ?? null };
  };
  const base = { status: null, fromStatus: null, amount: null, quantity: null, cancelStatus: null, failureCode: null, note: null } as const;
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
      if (c.status !== "FAILED") {
        events.push({ ...base, kind: "payment_cancel", at: at.toISOString(), amount: c.amount, cancelStatus: c.status, actor: system, note: c.reason });
        continue;
      }
      // 결제사가 준 문구는 거절 때 로그 추적에 남긴다(payment.cancel_failed, 같은 결제·금액의 마지막 행)
      const logged = cancelFailures.filter((a) => {
        const after = (a.after ?? {}) as { paymentId?: unknown; amount?: unknown };
        return after.paymentId === p.id && after.amount === c.amount;
      }).at(-1);
      const pgMessage = (logged?.after as { message?: unknown } | null | undefined)?.message;
      events.push({ ...base, kind: "payment_cancel", at: at.toISOString(), amount: c.amount, cancelStatus: c.status, failureCode: c.failureCode, actor: system, note: cancelFailureText(c.failureCode, typeof pgMessage === "string" ? pgMessage : null) });
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
