import { Prisma, type PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";
import { orderNoLabel } from "./orderNoLabel";

// 주문 알림 「보냈음」 기록(중복 발송 방지). 발송 연동(알림톡·문자)은 비용·외부 키가 필요해 아직 없다.
// 발송하는 쪽은 claim으로 보낼 주문을 먼저 잡고(OrderNotification PENDING), 보낸 뒤 잡을 때 받은 값(시도 번호 포함)으로
// markNotificationSent·Failed를 불러 결과를 남긴다.
// - 주문·종류마다 1행((orderId, kind) 유니크)이라 여러 곳에서 동시에 돌려도 한 주문을 한 번만 잡는다.
// - 실패했거나(FAILED) PENDING으로 오래(10분) 멈춘 기록은 시도 횟수(3번) 안에서 다시 잡는다. SENT는 다시 잡지 않는다.
// - 대상이 아니게 된 주문(입금·취소·기한 지남)은 잡지 않는다.
// - 이 기록만으로는 공급자 쪽 중복 발송을 다 막지 못한다(보냈는데 응답 전에 멈추면 다시 잡혀 또 보낼 수 있다). 그래서 발송 연동은
//   claim이 돌려주는 idempotencyKey(알림 id, 다시 잡아도 바뀌지 않음)를 공급자 멱등키로 보내야 한다. 멱등키를 지원하지 않는
//   공급자면 보냈는지 알 수 없는 실패(타임아웃 등)는 FAILED로 남기지 말고 확인 필요로 남겨 자동으로 다시 보내지 않는다.

export const MAX_NOTIFICATION_ATTEMPTS = 3;
export const STALE_CLAIM_MS = 10 * 60_000;

export type ClaimedNotification = {
  notificationId: string;
  // 공급자 멱등키로 보낼 값. 알림 id와 같고, 다시 잡아도(attempts가 늘어도) 바뀌지 않는다.
  idempotencyKey: string;
  orderId: string;
  sellerId: string;
  buyerMemberId: string;
  orderNo: number;
  // 안내 문구에 쓰는 주문번호(「20261005-0004」, 화면과 같음). 문구에는 orderNo·orderId·「#12」 표기를 쓰지 않는다.
  orderNoLabel: string;
  totalAmount: number;
  paymentDueAt: Date;
  attempts: number;
};

// 입금 기한 알림(PRODUCT_SCOPE: 기한 하루 전, 입금 기간이 하루 이하면 1시간 전) 보낼 주문을 잡는다.
// 대상 조건은 listPaymentDueSoon(orders/overdue.ts)과 같다.
// 처음 잡기·다시 잡기를 한 트랜잭션에서 하고, 맨 앞에서 종류별 잠금을 잡아 동시 실행을 한 줄로 세운다. 그래야 여러 곳이
// 동시에 돌려도 같은 앞쪽 주문을 두고 다투다 배치가 덜 차거나 비지 않는다(뒤에 온 쪽은 앞 쪽이 잡은 기록을 보고 다음 주문을 고른다).
export async function claimPaymentDueSoon(db: PrismaClient, opts: { now?: Date; limit?: number } = {}): Promise<ClaimedNotification[]> {
  return db.$transaction((tx) => claimPaymentDueSoonLocked(tx, opts), { timeout: 30_000 });
}

async function claimPaymentDueSoonLocked(db: Prisma.TransactionClient, opts: { now?: Date; limit?: number }): Promise<ClaimedNotification[]> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('order_notification_claim:PAYMENT_DUE_SOON'))`;
  const now = opts.now ?? (await dbNow(db));
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const due = Prisma.sql`
    SELECT o."id", o."sellerId", o."paymentDueAt" FROM "Order" o
    WHERE o."status" = 'PENDING_PAYMENT' AND o."paymentDueAt" > ${now}
      AND o."paymentDueAt" - CASE WHEN o."paymentDueAt" - o."createdAt" > INTERVAL '1 day' THEN INTERVAL '1 day' ELSE INTERVAL '1 hour' END <= ${now}`;
  // 처음 잡는 주문: 기록이 없는 주문만 골라 한도만큼 넣는다. 기록 있는 주문을 먼저 빼야 기한이 이른 기록 있는 주문에
  // 한도가 막혀 새 주문이 계속 밀리지 않는다. ON CONFLICT는 잠금 밖에서 넣은 기록에 대한 안전장치다.
  const fresh = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "OrderNotification" ("sellerId", "orderId", "kind", "status", "attempts", "claimedAt")
    SELECT d."sellerId", d."id", 'PAYMENT_DUE_SOON', 'PENDING', 1, ${now}
    FROM (${due}
      AND NOT EXISTS (SELECT 1 FROM "OrderNotification" n WHERE n."orderId" = o."id" AND n."kind" = 'PAYMENT_DUE_SOON')
      ORDER BY o."paymentDueAt" ASC LIMIT ${limit}) d
    ON CONFLICT ("orderId", "kind") DO NOTHING
    RETURNING "id"`;
  // 다시 잡는 주문: 실패했거나 PENDING으로 오래 멈췄고 시도 횟수가 남은 기록을 기한 이른 순으로, 처음 잡은 수를 뺀
  // 남은 한도만큼(합쳐 limit개까지). 조건부 갱신이라 잠금 밖의 갱신과 겹쳐도 한 번만 잡힌다.
  const remaining = limit - fresh.length;
  const retryable = Prisma.sql`n."kind" = 'PAYMENT_DUE_SOON' AND n."attempts" < ${MAX_NOTIFICATION_ATTEMPTS}
      AND (n."status" = 'FAILED' OR (n."status" = 'PENDING' AND n."claimedAt" <= ${staleBefore}))`;
  const retried = remaining <= 0 ? [] : await db.$queryRaw<{ id: string }[]>`
    UPDATE "OrderNotification" n
    SET "status" = 'PENDING', "attempts" = n."attempts" + 1, "claimedAt" = ${now}, "failureReason" = NULL
    WHERE ${retryable} AND n."id" IN (
      SELECT n."id" FROM "OrderNotification" n JOIN (${due}) d ON d."id" = n."orderId"
      WHERE ${retryable}
      ORDER BY d."paymentDueAt" ASC LIMIT ${remaining})
    RETURNING n."id"`;
  const ids = [...fresh, ...retried].map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await db.orderNotification.findMany({
    where: { id: { in: ids } },
    include: { order: { select: { buyerMemberId: true, orderNo: true, createdAt: true, totalAmount: true, paymentDueAt: true } } },
  });
  return rows
    .map((n) => ({
      notificationId: n.id,
      idempotencyKey: n.id,
      orderId: n.orderId,
      sellerId: n.sellerId,
      buyerMemberId: n.order.buyerMemberId,
      orderNo: n.order.orderNo,
      orderNoLabel: orderNoLabel(n.order.createdAt, n.order.orderNo),
      totalAmount: n.order.totalAmount,
      paymentDueAt: n.order.paymentDueAt!,
      attempts: n.attempts,
    }))
    .sort((a, b) => a.paymentDueAt.getTime() - b.paymentDueAt.getTime());
}

// 결과 기록은 잡을 때 받은 시도 번호(attempts)가 지금 기록과 같을 때만 한다. 10분 넘게 멈췄다 돌아온 옛 작업자가
// 그사이 다시 잡힌 새 시도의 결과를 덮어쓰지 못하게 한다.
type Claim = Pick<ClaimedNotification, "notificationId" | "attempts">;

// 보냈음. 잡혀 있던(PENDING) 같은 시도만 바꾼다. 바꿨으면 true.
export async function markNotificationSent(db: PrismaClient, claim: Claim, now?: Date): Promise<boolean> {
  const at = now ?? (await dbNow(db));
  const r = await db.orderNotification.updateMany({ where: { id: claim.notificationId, status: "PENDING", attempts: claim.attempts }, data: { status: "SENT", sentAt: at } });
  return r.count === 1;
}

// 보내지 못함. 잡혀 있던(PENDING) 같은 시도만 바꾼다. 사유는 200자까지(비밀값·개인정보를 넣지 않는다). 바꿨으면 true.
export async function markNotificationFailed(db: PrismaClient, claim: Claim, reason: string): Promise<boolean> {
  const r = await db.orderNotification.updateMany({
    where: { id: claim.notificationId, status: "PENDING", attempts: claim.attempts },
    data: { status: "FAILED", failureReason: reason.slice(0, 200) },
  });
  return r.count === 1;
}
