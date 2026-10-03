import type { ActorType, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { recordOrderEarn } from "../queue/service";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { dbClock, getOrderPolicy } from "./overdue";

// 배송 완료·구매 확정(PRODUCT_SCOPE 「배송 완료」·「구매 확정」, 「적립금 지급 시점」).
// - 배송 완료: 판매자가 직접 처리하거나, 배송 중으로 n일(판매자 설정, 기본 사용·7일)이 지나면 자동으로 처리한다.
//   택배사 배송 추적 연동은 출시 후. 주문 상태(status)는 결제 완료(PAID) 그대로 두고 배송(Shipment) 상태만 바꾼다.
// - 적립금: 배송 완료 때 아직 지급 기록(EARN)이 없으면 기록한다. 「결제 즉시」 쇼핑몰은 결제 때 이미 기록돼 그대로 둔다
//   (결제 뒤 설정을 바꿔도 배송 완료까지는 한 번 기록된다).
// - 구매 확정: 배송 완료 뒤 n일(기본 사용·7일)이 지나면 자동으로 Order.purchaseConfirmedAt을 남긴다.
// 자동 처리는 여러 번 돌려도 같은 결과(멱등)이고, 한 건이 실패해도 나머지는 계속한다. 정기 실행(cron) 연결은 인프라 승인 대기라 함수만 둔다.
// 자동 처리는 후보를 고른 뒤 주문마다 트랜잭션 안에서 주문을 잠그고 상태·판매자 설정(켜짐·기간)을 DB 시계로 다시 확인한다.

type Tx = Prisma.TransactionClient;
type Actor = { actorType: ActorType; actorId: string | null };
export type DeliverFailure = "not_found" | "not_deliverable";

const DAY_MS = 24 * 60 * 60 * 1000;

// 주문 행을 잠가 발송·환불과 겹치지 않게 한다. 잠근 뒤의 DB 시각(clock_timestamp)을 돌려준다.
async function lockOrder(tx: Tx, sellerId: string, orderId: string) {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "Order" WHERE "id" = ${orderId}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return rows[0] ? { status: rows[0].status, now: await dbClock(tx) } : null;
}

// 결제 완료·배송 중일 때만 배송 완료로 바꾼다. 자동 처리면 잠근 뒤 판매자 설정(켜짐·기간)을 다시 읽어,
// 후보를 고른 뒤 설정을 끄거나 기간을 늘렸으면 처리하지 않는다.
async function deliverLocked(tx: Tx, sellerId: string, orderId: string, actor: Actor, auto: boolean) {
  const locked = await lockOrder(tx, sellerId, orderId);
  if (!locked) return { ok: false as const, reason: "not_found" as const };
  const { now } = locked;
  const shipment = await tx.shipment.findUnique({ where: { orderId } });
  if (locked.status !== "PAID" || shipment?.status !== "IN_TRANSIT") return { ok: false as const, reason: "not_deliverable" as const };
  if (auto) {
    const policy = await getOrderPolicy(tx, sellerId);
    if (!policy.autoDeliverEnabled || shipment.shippedAt.getTime() + policy.autoDeliverDays * DAY_MS > now.getTime()) {
      return { ok: false as const, reason: "not_deliverable" as const };
    }
  }
  await tx.shipment.update({ where: { orderId }, data: { status: "DELIVERED", deliveredAt: now } });
  const rewardEarned = await recordOrderEarn(tx, { sellerId, orderId, now });
  await writeAudit(tx, {
    ...actor,
    sellerId,
    action: auto ? "order.auto_deliver" : "order.deliver",
    targetType: "Order",
    targetId: orderId,
    before: { shipmentStatus: "IN_TRANSIT" },
    after: { shipmentStatus: "DELIVERED", rewardEarned },
  });
  return { ok: true as const, deliveredAt: now, rewardEarned };
}

// 판매자가 직접 배송 완료 처리(ORDER_SHIPPING). 배송 중이 아니면(발송 전·이미 완료·환불) not_deliverable.
export async function completeDelivery(db: PrismaClient, ctx: TenantContext, orderId: string) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  return db.$transaction((tx) => deliverLocked(tx, ctx.sellerId, orderId, { actorType: ctx.actorType, actorId: ctx.actorId }, false));
}

const SYSTEM: Actor = { actorType: "SYSTEM", actorId: null };

// 자동 배송 완료 대상: 결제 완료·배송 중이고, 발송 시각 + 판매자 설정 일수가 지난 주문(설정이 없으면 기본 사용·7일).
export async function autoCompleteDeliveries(db: PrismaClient, opts: { now?: Date; limit?: number } = {}) {
  const asOf = opts.now ?? (await dbClock(db));
  const due = await db.$queryRaw<{ orderId: string; sellerId: string }[]>`
    SELECT s."orderId", s."sellerId" FROM "Shipment" s
    JOIN "Order" o ON o."id" = s."orderId"
    LEFT JOIN "SellerOrderPolicy" p ON p."sellerId" = s."sellerId"
    WHERE s."status" = 'IN_TRANSIT' AND o."status" = 'PAID'
      AND COALESCE(p."autoDeliverEnabled", true)
      AND s."shippedAt" + make_interval(days => COALESCE(p."autoDeliverDays", 7)) <= ${asOf}
    ORDER BY s."shippedAt" ASC
    LIMIT ${Math.min(opts.limit ?? 100, 500)}`;
  return runEach(db, due, "order.auto_deliver_failed", autoDeliverOrder);
}

// 자동 배송 완료 한 건(후보 하나). 트랜잭션 안에서 상태·설정·기간을 다시 확인한다. 처리했으면 true.
async function autoDeliverOrder(tx: Tx, o: { orderId: string; sellerId: string }) {
  return (await deliverLocked(tx, o.sellerId, o.orderId, SYSTEM, true)).ok;
}

// 자동 구매 확정 대상: 결제 완료·배송 완료이고 아직 확정 전이며, 배송 완료 시각 + 판매자 설정 일수가 지난 주문.
export async function autoConfirmPurchases(db: PrismaClient, opts: { now?: Date; limit?: number } = {}) {
  const asOf = opts.now ?? (await dbClock(db));
  const due = await db.$queryRaw<{ orderId: string; sellerId: string }[]>`
    SELECT s."orderId", s."sellerId" FROM "Shipment" s
    JOIN "Order" o ON o."id" = s."orderId"
    LEFT JOIN "SellerOrderPolicy" p ON p."sellerId" = s."sellerId"
    WHERE s."status" = 'DELIVERED' AND o."status" = 'PAID' AND o."purchaseConfirmedAt" IS NULL
      AND COALESCE(p."autoConfirmEnabled", true)
      AND s."deliveredAt" + make_interval(days => COALESCE(p."autoConfirmDays", 7)) <= ${asOf}
    ORDER BY s."deliveredAt" ASC
    LIMIT ${Math.min(opts.limit ?? 100, 500)}`;
  return runEach(db, due, "order.auto_confirm_failed", autoConfirmOrder);
}

// 자동 구매 확정 한 건(후보 하나). 주문을 잠근 뒤 상태·판매자 설정(켜짐·기간)·배송 완료 시각을 다시 확인한다.
// 그사이 환불·확정됐거나, 설정을 끄거나 기간을 늘렸으면 처리하지 않는다. 처리했으면 true.
async function autoConfirmOrder(tx: Tx, o: { orderId: string; sellerId: string }) {
  const locked = await lockOrder(tx, o.sellerId, o.orderId);
  if (!locked || locked.status !== "PAID") return false;
  const order = await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { purchaseConfirmedAt: true, shipment: { select: { status: true, deliveredAt: true } } } });
  const deliveredAt = order.shipment?.status === "DELIVERED" ? order.shipment.deliveredAt : null;
  if (order.purchaseConfirmedAt || !deliveredAt) return false;
  const policy = await getOrderPolicy(tx, o.sellerId);
  if (!policy.autoConfirmEnabled || deliveredAt.getTime() + policy.autoConfirmDays * DAY_MS > locked.now.getTime()) return false;
  await tx.order.update({ where: { id: o.orderId }, data: { purchaseConfirmedAt: locked.now } });
  await writeAudit(tx, { ...SYSTEM, sellerId: o.sellerId, action: "order.purchase_confirmed", targetType: "Order", targetId: o.orderId });
  return true;
}

async function runEach(
  db: PrismaClient,
  due: { orderId: string; sellerId: string }[],
  failAction: string,
  body: (tx: Tx, o: { orderId: string; sellerId: string }) => Promise<boolean>,
) {
  const done: string[] = [];
  const failed: string[] = [];
  for (const o of due) {
    try {
      // 커밋된 뒤에만 결과에 넣는다
      if (await db.$transaction((tx) => body(tx, o))) done.push(o.orderId);
    } catch (e) {
      console.error(`[${failAction}]`, o.orderId, e);
      failed.push(o.orderId);
      await writeAudit(db, {
        ...SYSTEM,
        sellerId: o.sellerId,
        action: failAction,
        targetType: "Order",
        targetId: o.orderId,
        reason: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      }).catch((logError) => console.error(`[${failAction}] 감사 로그 실패`, o.orderId, logError));
    }
  }
  return { done, failed };
}
