import { Prisma, type PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";

// 주문 알림 「보냈음」 기록(중복 발송 방지). 발송 연동(알림톡·문자)은 비용·외부 키가 필요해 아직 없다.
// 발송하는 쪽은 claim으로 보낼 주문을 먼저 잡고(OrderNotification PENDING), 보낸 뒤 markNotificationSent·Failed로 결과를 남긴다.
// - 주문·종류마다 1행((orderId, kind) 유니크)이라 여러 곳에서 동시에 돌려도 한 주문을 한 번만 잡는다.
// - 실패했거나(FAILED) PENDING으로 오래(10분) 멈춘 기록은 시도 횟수(3번) 안에서 다시 잡는다. SENT는 다시 잡지 않는다.
// - 대상이 아니게 된 주문(입금·취소·기한 지남)은 잡지 않는다.

export const MAX_NOTIFICATION_ATTEMPTS = 3;
export const STALE_CLAIM_MS = 10 * 60_000;

export type ClaimedNotification = {
  notificationId: string;
  orderId: string;
  sellerId: string;
  buyerMemberId: string;
  orderNo: number;
  totalAmount: number;
  paymentDueAt: Date;
  attempts: number;
};

// 입금 기한 알림(PRODUCT_SCOPE: 기한 하루 전, 입금 기간이 하루 이하면 1시간 전) 보낼 주문을 잡는다.
// 대상 조건은 listPaymentDueSoon(orders/overdue.ts)과 같다.
export async function claimPaymentDueSoon(db: PrismaClient, opts: { now?: Date; limit?: number } = {}): Promise<ClaimedNotification[]> {
  const now = opts.now ?? (await dbNow(db));
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const due = Prisma.sql`
    SELECT o."id", o."sellerId" FROM "Order" o
    WHERE o."status" = 'PENDING_PAYMENT' AND o."paymentDueAt" > ${now}
      AND o."paymentDueAt" - CASE WHEN o."paymentDueAt" - o."createdAt" > INTERVAL '1 day' THEN INTERVAL '1 day' ELSE INTERVAL '1 hour' END <= ${now}`;
  // 처음 잡는 주문: 기록이 없으면 넣는다(이미 있으면 그대로 두고 건너뛴다)
  const fresh = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "OrderNotification" ("sellerId", "orderId", "kind", "status", "attempts", "claimedAt")
    SELECT d."sellerId", d."id", 'PAYMENT_DUE_SOON', 'PENDING', 1, ${now}
    FROM (${due} ORDER BY o."paymentDueAt" ASC LIMIT ${limit}) d
    ON CONFLICT ("orderId", "kind") DO NOTHING
    RETURNING "id"`;
  // 다시 잡는 주문: 실패했거나 PENDING으로 오래 멈췄고 시도 횟수가 남은 기록(조건부 갱신이라 동시에 돌려도 한 번만 잡힌다)
  const retried = await db.$queryRaw<{ id: string }[]>`
    UPDATE "OrderNotification" n
    SET "status" = 'PENDING', "attempts" = n."attempts" + 1, "claimedAt" = ${now}, "failureReason" = NULL
    FROM (${due}) d
    WHERE n."orderId" = d."id" AND n."kind" = 'PAYMENT_DUE_SOON' AND n."attempts" < ${MAX_NOTIFICATION_ATTEMPTS}
      AND (n."status" = 'FAILED' OR (n."status" = 'PENDING' AND n."claimedAt" <= ${staleBefore}))
    RETURNING n."id"`;
  const ids = [...fresh, ...retried].map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await db.orderNotification.findMany({
    where: { id: { in: ids } },
    include: { order: { select: { buyerMemberId: true, orderNo: true, totalAmount: true, paymentDueAt: true } } },
  });
  return rows
    .map((n) => ({
      notificationId: n.id,
      orderId: n.orderId,
      sellerId: n.sellerId,
      buyerMemberId: n.order.buyerMemberId,
      orderNo: n.order.orderNo,
      totalAmount: n.order.totalAmount,
      paymentDueAt: n.order.paymentDueAt!,
      attempts: n.attempts,
    }))
    .sort((a, b) => a.paymentDueAt.getTime() - b.paymentDueAt.getTime());
}

// 보냈음. 잡혀 있던(PENDING) 기록만 바꾼다. 바꿨으면 true.
export async function markNotificationSent(db: PrismaClient, notificationId: string, now?: Date): Promise<boolean> {
  const at = now ?? (await dbNow(db));
  const r = await db.orderNotification.updateMany({ where: { id: notificationId, status: "PENDING" }, data: { status: "SENT", sentAt: at } });
  return r.count === 1;
}

// 보내지 못함. 잡혀 있던(PENDING) 기록만 바꾼다. 사유는 200자까지(비밀값·개인정보를 넣지 않는다). 바꿨으면 true.
export async function markNotificationFailed(db: PrismaClient, notificationId: string, reason: string): Promise<boolean> {
  const r = await db.orderNotification.updateMany({
    where: { id: notificationId, status: "PENDING" },
    data: { status: "FAILED", failureReason: reason.slice(0, 200) },
  });
  return r.count === 1;
}
