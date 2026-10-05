import { Prisma, type ActorType, type PaymentMethod, type PrismaClient, type QueueItem, type RefundFault } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notifySellerChanged } from "../realtime/notify";
import { lockSellerOrders, maybeRestrict, sellerEventClock } from "../orders/overdue";
import { getShippingPolicy } from "../orders/shipping";
import { earnQuote } from "../rewards/earn";
import { createPendingRewardLedger } from "../rewards/ledger";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { restoreOrderStock } from "../products/stock";
import { closeReturnsOnRefund } from "../shop-returns/hooks";
import { checkTransition, isCompletePermutation, isValidTimer, type QueueAction, type QueueRejection } from "./rules";
import { refreshOrderRetention } from "../buyers/legalHold";
import { chargedShippingFee, itemCouponDiscount, restoreOrderCoupon } from "../shop-coupons/service";
import { revokeReviewRewardsForOrder, type ReviewRewardRevoke } from "../product-reviews/service";
import { requestPaymentCancel } from "../payments/service";
import { returnRewardForOrder, rewardReturnAmount } from "../payments/rewardUse";
import { computeRefundStep, earnRevokeStep, itemValue, type RefundCalcItem } from "../payments/refundCalc";
import { settleRefundRequestsOnRefund } from "../payments/refundRequestHooks";

type Tx = Prisma.TransactionClient;

export type QueueResult<T> = { ok: true; value: T; version: number } | { ok: false; reason: QueueRejection };

class Rejected extends Error {
  constructor(readonly reason: QueueRejection) {
    super(reason);
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// 시각은 DB 시계로 정한다(앱 서버마다 시계가 달라도 판정이 같게). 테스트는 now를 넘겨 고정한다.
async function dbNow(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

// 판매자 행을 잠그고 실시간 version을 올린다. 같은 판매자의 주문대기 변경은 이 잠금으로 한 줄로 처리된다.
async function lockAndBump(tx: Tx, sellerId: string): Promise<number> {
  const s = await tx.seller.update({ where: { id: sellerId }, data: { liveVersion: { increment: 1 } }, select: { liveVersion: true } });
  return s.liveVersion;
}

// 트랜잭션 실행 → 거부 사유는 결과로, 커밋되면 NOTIFY.
async function run<T>(
  db: PrismaClient,
  sellerId: string,
  body: (tx: Tx, version: number) => Promise<T>,
  onUnique: QueueRejection = "conflict",
): Promise<QueueResult<T>> {
  let out: { value: T; version: number };
  try {
    out = await db.$transaction(async (tx) => {
      const version = await lockAndBump(tx, sellerId);
      return { value: await body(tx, version), version };
    });
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, reason: e.reason };
    if (isUniqueViolation(e)) return { ok: false, reason: onUnique };
    throw e;
  }
  await notifySellerChanged(db, sellerId, out.version);
  return { ok: true, ...out };
}

const ACTION_AUDIT: Record<QueueAction, string> = {
  start: "queue.start",
  complete: "queue.complete",
  revert: "queue.revert",
  cancel: "queue.cancel",
  timer: "queue.timer",
};

export type QueueActionOptions = { expectedVersion?: number; reason?: string; timerSeconds?: number; now?: Date };

// 개봉 시작 / 개봉 완료 / 완료 되돌리기 / 취소 / 타이머 조정
export async function applyQueueAction(
  db: PrismaClient,
  ctx: TenantContext,
  itemId: string,
  action: QueueAction,
  opts: QueueActionOptions = {},
): Promise<QueueResult<QueueItem>> {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  if (action === "timer" && !isValidTimer(opts.timerSeconds)) return { ok: false, reason: "invalid_timer" };
  // 취소는 사유가 있어야 한다(상태 기록·감사 로그에 남긴다).
  if (action === "cancel" && !opts.reason?.trim()) return { ok: false, reason: "reason_required" };

  return run(
    db,
    ctx.sellerId,
    async (tx) => {
      const now = opts.now ?? (await dbNow(tx));
      const item = await tx.queueItem.findFirst({
        where: { id: itemId, sellerId: ctx.sellerId },
        include: { broadcastSession: { select: { status: true } } },
      });
      if (!item) throw new Rejected("not_found");
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== item.version) throw new Rejected("conflict");

      const hasOtherOpening =
        (await tx.queueItem.count({ where: { sellerId: ctx.sellerId, status: "OPENING", id: { not: item.id } } })) > 0;
      const check = checkTransition(
        { status: item.status, doneAt: item.doneAt, inLiveBroadcast: item.broadcastSession?.status === "LIVE" },
        action,
        { now, hasOtherOpening },
      );
      if (!check.ok) throw new Rejected(check.reason);

      const data: Prisma.QueueItemUpdateInput =
        action === "start"
          ? { status: "OPENING", openingStartedAt: now }
          : action === "complete"
            ? { status: "DONE", doneAt: now }
            : action === "revert"
              ? { status: "OPENING", doneAt: null }
              : action === "cancel"
                ? { status: "CANCELLED", cancelledAt: now, cancelReason: opts.reason ?? null }
                : { timerSeconds: opts.timerSeconds };

      const updated = await tx.queueItem.update({ where: { id: item.id }, data: { ...data, version: { increment: 1 } } });

      if (updated.status !== item.status) {
        await tx.queueItemStatusHistory.create({
          data: {
            sellerId: ctx.sellerId,
            queueItemId: item.id,
            fromStatus: item.status,
            toStatus: updated.status,
            actorType: ctx.actorType,
            actorId: ctx.actorId,
            reason: opts.reason ?? null,
            createdAt: now,
          },
        });
      }
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: ACTION_AUDIT[action],
        targetType: "QueueItem",
        targetId: item.id,
        before: { status: item.status, timerSeconds: item.timerSeconds },
        after: { status: updated.status, timerSeconds: updated.timerSeconds },
        reason: opts.reason,
      });
      return updated;
    },
    // 동시에 두 건을 개봉 시작하면 판매자당 「개봉 중」 1건 인덱스가 막는다.
    "other_opening",
  );
}

// 순서 변경: 같은 방송(또는 방송 전 미배정) 범위의 「대기」 항목 전체를 새 순서로 보낸다.
// expectedLiveVersion: 화면이 받은 상태의 version. 그사이 바뀌었으면 낡은 화면이므로 거부한다.
export async function reorderWaiting(
  db: PrismaClient,
  ctx: TenantContext,
  input: { broadcastSessionId: string | null; orderedIds: string[]; expectedLiveVersion: number },
): Promise<QueueResult<number>> {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  return run(db, ctx.sellerId, async (tx, version) => {
    if (version - 1 !== input.expectedLiveVersion) throw new Rejected("conflict");
    const current = await tx.queueItem.findMany({
      where: { sellerId: ctx.sellerId, status: "WAITING", broadcastSessionId: input.broadcastSessionId },
      select: { id: true },
    });
    if (!isCompletePermutation(current.map((c) => c.id), input.orderedIds)) throw new Rejected("conflict");
    for (const [i, id] of input.orderedIds.entries()) {
      await tx.queueItem.update({ where: { id }, data: { position: i + 1, version: { increment: 1 } } });
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "queue.reorder",
      targetType: "BroadcastSession",
      targetId: input.broadcastSessionId ?? undefined,
      after: { orderedIds: input.orderedIds },
    });
    return input.orderedIds.length;
  });
}

// 방송 시작: 방송 전에 쌓인 「대기」 주문을 접수 시각 순으로 새 방송에 자동 편입한다.
export async function startBroadcast(
  db: PrismaClient,
  ctx: TenantContext,
  input: { title?: string; now?: Date } = {},
): Promise<QueueResult<{ broadcastSessionId: string; absorbed: number }>> {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const now = input.now ?? new Date();
  return run(
    db,
    ctx.sellerId,
    async (tx) => {
      if (await tx.broadcastSession.findFirst({ where: { sellerId: ctx.sellerId, status: "LIVE" }, select: { id: true } })) {
        throw new Rejected("already_live");
      }
      const session = await tx.broadcastSession.create({ data: { sellerId: ctx.sellerId, title: input.title, startedAt: now } });
      const pending = await tx.queueItem.findMany({
        where: { sellerId: ctx.sellerId, status: "WAITING", broadcastSessionId: null },
        orderBy: [{ position: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      for (const [i, p] of pending.entries()) {
        await tx.queueItem.update({
          where: { id: p.id },
          data: { broadcastSessionId: session.id, position: i + 1, version: { increment: 1 } },
        });
      }
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorType === "SYSTEM" ? null : ctx.actorId,
        sellerId: ctx.sellerId,
        action: "broadcast.start",
        targetType: "BroadcastSession",
        targetId: session.id,
        after: { absorbed: pending.length },
      });
      return { broadcastSessionId: session.id, absorbed: pending.length };
    },
    "already_live",
  );
}

// 방송 종료: 「개봉 중」이 남아 있으면 거부. 남은 「대기」는 미배정으로 돌려 다음 방송에 이어진다.
export async function endBroadcast(
  db: PrismaClient,
  ctx: TenantContext,
  input: { now?: Date; broadcastSessionId?: string } = {},
): Promise<QueueResult<{ broadcastSessionId: string; carriedOver: number }>> {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const now = input.now ?? new Date();
  return run(db, ctx.sellerId, async (tx) => {
    const live = await tx.broadcastSession.findFirst({ where: { sellerId: ctx.sellerId, status: "LIVE" } });
    if (!live) throw new Rejected("not_live");
    // 화면이 확인한 방송(A)이 아닌 다른 방송(B)이 지금 LIVE이면 종료하지 않는다(A를 끝내려다 B를 끝내는 일 방지)
    if (input.broadcastSessionId !== undefined && input.broadcastSessionId !== live.id) throw new Rejected("not_live");
    if (await tx.queueItem.count({ where: { sellerId: ctx.sellerId, broadcastSessionId: live.id, status: "OPENING" } })) {
      throw new Rejected("opening_in_progress");
    }
    // 남은 대기는 방송 전 대기 맨 뒤로, 원래 순서를 지켜 옮긴다.
    const remaining = await tx.queueItem.findMany({
      where: { sellerId: ctx.sellerId, broadcastSessionId: live.id, status: "WAITING" },
      orderBy: [{ position: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const max = await tx.queueItem.aggregate({ where: { sellerId: ctx.sellerId, broadcastSessionId: null }, _max: { position: true } });
    let position = max._max.position ?? 0;
    for (const r of remaining) {
      await tx.queueItem.update({ where: { id: r.id }, data: { broadcastSessionId: null, position: ++position, version: { increment: 1 } } });
    }
    const carried = { count: remaining.length };
    await tx.broadcastSession.update({ where: { id: live.id }, data: { status: "ENDED", endedAt: now } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorType === "SYSTEM" ? null : ctx.actorId,
      sellerId: ctx.sellerId,
      action: "broadcast.end",
      targetType: "BroadcastSession",
      targetId: live.id,
      after: { carriedOver: carried.count },
    });
    return { broadcastSessionId: live.id, carriedOver: carried.count };
  });
}

// ───────────── 결제 완료 → 재고 차감 → 주문대기 생성 ─────────────

class StockShortage extends Error {}

export type PaidOutcome = { orderId: string; stockShortage: boolean; queueItemIds: string[] };

// 결제 완료 처리(이번 단계는 내부 함수, PG 연동 전). 아직 재고를 안 뺀 품목(결제 때 차감 상품)을 한 트랜잭션에서 빼고,
// 하나라도 모자라면 모두 되돌린 뒤 주문에 stockShortageAt만 기록한다(주문대기·적립 원장 없음). 주문 때 뺀 품목은 그대로 둔다.
export async function markOrderPaid(
  db: PrismaClient,
  input: { sellerId: string; orderId: string; paymentMethod?: PaymentMethod; now?: Date },
): Promise<QueueResult<PaidOutcome>> {
  const { sellerId, orderId } = input;
  const now = input.now ?? new Date();
  const system = { actorType: "SYSTEM" as const, actorId: null };

  try {
    return await run(db, sellerId, async (tx) => {
      const order = await loadPendingOrder(tx, sellerId, orderId);
      // 결제수단을 넘기지 않으면 주문에 이미 있는 값을 쓴다(저장·적립 계산 모두).
      const paymentMethod = input.paymentMethod ?? order.paymentMethod;
      // 상태 조건을 걸어 바꾼다: 자동 취소(overdue.ts)가 같은 주문을 먼저 취소했으면 결제로 덮어쓰지 않는다
      await markPaidIfPending(tx, sellerId, orderId, { status: "PAID", paidAt: now, paymentMethod });
      await tx.orderStatusHistory.create({
        data: { sellerId, orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", ...system, createdAt: now },
      });

      // 주문 때 이미 뺀 품목(ORDER 상품)은 건너뛰고, 아직 안 뺀 품목(PAYMENT 상품)만 뺀다
      for (const item of order.items.filter((i) => i.stockDeductedAt === null)) {
        const dec = await tx.productOption.updateMany({
          where: { id: item.optionId, sellerId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (dec.count === 0) throw new StockShortage();
        await tx.stockMovement.create({
          data: { sellerId, optionId: item.optionId, delta: -item.quantity, reason: "ORDER", orderId, ...system, createdAt: now },
        });
        await tx.orderItem.update({ where: { id: item.id }, data: { stockDeductedAt: now } });
      }

      const live = await tx.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true } });
      const scope = { sellerId, broadcastSessionId: live?.id ?? null };
      const max = await tx.queueItem.aggregate({ where: scope, _max: { position: true } });
      let position = max._max.position ?? 0;
      const queueItemIds: string[] = [];
      for (const item of order.items) {
        const q = await tx.queueItem.create({
          data: {
            ...scope,
            orderId,
            orderItemId: item.id,
            position: ++position,
            receivedAt: now,
            nicknameSnapshot: order.broadcastNicknameSnapshot,
            gradeSnapshot: order.buyerMember.grade.displayName,
            productLabel: `${item.productNameSnapshot} ${item.optionNameSnapshot}`.trim(),
            quantity: item.quantity,
          },
        });
        queueItemIds.push(q.id);
      }
      // 적립은 결제 시점 스냅숏으로 판정한다(지급 시점·등급·적립률·예정액, 지급 시작일은 결제 시각과 비교).
      // 「결제 즉시」면 지금 기록하고, 「배송 완료 후」(기본)는 배송 완료 때 남겨 둔 예정액으로 기록한다(orders/delivery.ts).
      const policy = await tx.rewardPolicy.findUnique({ where: { sellerId } });
      if (policy) {
        const quote = earnQuote({
          rates: policy.rates,
          earnStartsAt: policy.earnStartsAt,
          gradeId: order.buyerMember.gradeId,
          paymentMethod,
          // 쿠폰을 쓴 주문은 품목별 쿠폰 할인을 뺀 금액이 기준(MASTER 2026-10-04 보수적 기본값, 대표님 확정 대기)
          base: rewardBase(order.items) - order.items.reduce((sum, i) => sum + itemCouponDiscount(order.couponRedemption, i.optionId), 0),
          now,
        });
        await tx.order.update({
          where: { id: orderId },
          data: { rewardEarnTiming: policy.earnTiming, rewardGradeId: order.buyerMember.gradeId, rewardRate: quote.rate, rewardEarnAmount: quote.amount },
        });
        if (policy.earnTiming === "ON_PAYMENT" && quote.amount > 0) {
          await createEarn(tx, { sellerId, buyerMemberId: order.buyerMemberId, orderId, amount: quote.amount, testMode: !policy.livePayoutEnabled, now });
        }
      }
      await writeAudit(tx, { ...system, sellerId, action: "order.paid", targetType: "Order", targetId: orderId });
      return { orderId, stockShortage: false, queueItemIds };
    });
  } catch (e) {
    if (!(e instanceof StockShortage)) throw e;
  }

  return run(db, sellerId, async (tx) => {
    const order = await loadPendingOrder(tx, sellerId, orderId);
    await markPaidIfPending(tx, sellerId, orderId, { status: "PAID", paidAt: now, paymentMethod: input.paymentMethod ?? order.paymentMethod, stockShortageAt: now });
    await tx.orderStatusHistory.create({
      data: { sellerId, orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", ...system, reason: "stock_shortage", createdAt: now },
    });
    await writeAudit(tx, { ...system, sellerId, action: "order.stock_shortage", targetType: "Order", targetId: orderId });
    return { orderId, stockShortage: true, queueItemIds: [] };
  });
}

// 적립 기준액(대표님 결정 2026-10-03): 할인 후 상품 금액(주문 품목 단가 × 수량 합). 배송비는 빼고, 적립금으로 낸 금액은 빼지 않는다.
export function rewardBase(items: { unitPrice: number; quantity: number }[]): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
}

// 적립금 지급 대기(EARN) 기록. 실지급 스위치가 꺼져 있으면 testMode. 지급·잔액 반영은 다음 단계.
async function createEarn(tx: Tx, e: { sellerId: string; buyerMemberId: string; orderId: string; amount: number; testMode: boolean; now: Date }) {
  await createPendingRewardLedger(tx, {
    sellerId: e.sellerId,
    buyerMemberId: e.buyerMemberId,
    orderId: e.orderId,
    type: "EARN",
    amount: e.amount,
    testMode: e.testMode,
    idempotencyKey: `earn:${e.orderId}`,
    createdAt: e.now,
  });
}

// 배송 완료 때 적립: 결제 때 남긴 스냅숏의 지급 시점이 「배송 완료 후」이고 예정액이 0원보다 클 때만 그 금액으로 한 번 기록한다
// (결제 뒤 적립률·지급 시작일·등급·지급 시점을 바꿔도 결과는 같다). 이미 기록이 있으면 그대로 둔다. 기록했으면 금액, 아니면 0.
export async function recordOrderEarn(tx: Tx, input: { sellerId: string; orderId: string; now: Date }): Promise<number> {
  const { sellerId, orderId, now } = input;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { buyerMemberId: true, rewardEarnTiming: true, rewardEarnAmount: true } });
  const amount = order.rewardEarnAmount ?? 0;
  if (order.rewardEarnTiming !== "ON_DELIVERY" || amount <= 0) return 0;
  if (await tx.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId, idempotencyKey: `earn:${orderId}` } }, select: { id: true } })) return 0;
  // 실지급 스위치는 기록하는 때의 값을 따른다(지급 여부 스위치라 금액 판정과 별개)
  const policy = await tx.rewardPolicy.findUnique({ where: { sellerId }, select: { livePayoutEnabled: true } });
  await createEarn(tx, { sellerId, buyerMemberId: order.buyerMemberId, orderId, amount, testMode: !policy?.livePayoutEnabled, now });
  return amount;
}

async function markPaidIfPending(tx: Tx, sellerId: string, orderId: string, data: Prisma.OrderUpdateManyMutationInput) {
  const moved = await tx.order.updateMany({ where: { id: orderId, sellerId, status: "PENDING_PAYMENT" }, data });
  if (moved.count !== 1) throw new Rejected("invalid_transition");
}

async function loadPendingOrder(tx: Tx, sellerId: string, orderId: string) {
  const order = await tx.order.findFirst({
    where: { id: orderId, sellerId },
    include: { items: { orderBy: { createdAt: "asc" } }, buyerMember: { include: { grade: true } }, couponRedemption: { select: { itemDiscounts: true } } },
  });
  if (!order) throw new Rejected("not_found");
  if (order.status !== "PENDING_PAYMENT") throw new Rejected("invalid_transition");
  return order;
}

// ───────────── 주문 취소·환불 (ARCHITECTURE 4.5, MASTER 지시) ─────────────

// 결제 전 주문 취소: 결제 대기 → 취소. 재고는 결제 때 빼므로 되돌릴 것이 없다.
export async function cancelPendingOrder(
  db: PrismaClient,
  ctx: TenantContext,
  orderId: string,
  opts: { reason?: string; expectedLiveVersion: number; now?: Date },
): Promise<QueueResult<{ orderId: string }>> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!opts.reason?.trim()) return { ok: false, reason: "reason_required" };
  const reason = opts.reason.trim();
  return run(db, ctx.sellerId, async (tx, version) => {
    // 화면이 본 상태(version) 그대로일 때만 처리한다(주문대기 조작과 같은 규칙)
    if (version - 1 !== opts.expectedLiveVersion) throw new Rejected("conflict");
    const now = opts.now ?? (await dbNow(tx));
    await cancelPendingOrderInTx(tx, { sellerId: ctx.sellerId, orderId, now, actorType: ctx.actorType, actorId: ctx.actorId, reason });
    return { orderId };
  });
}

// 결제 대기 주문 하나를 취소한다(호출한 쪽이 트랜잭션·잠금을 잡는다). 판매자 취소와 탈퇴 때 자동 취소(buyers/withdraw.ts)가 같이 쓴다.
// 상태 조건으로 바꾸고, 상태 이력·주문 때 뺀 재고 되돌리기(restockOnCancel)·감사 로그 order.cancel을 남긴다. 결제 대기가 아니면 Rejected.
// 주문대기는 결제 때 만들므로 결제 대기 주문에는 없다.
export async function cancelPendingOrderInTx(
  tx: Tx,
  o: { sellerId: string; orderId: string; now: Date; actorType: ActorType; actorId: string | null; reason: string },
) {
  const moved = await tx.order.updateMany({
    where: { id: o.orderId, sellerId: o.sellerId, status: "PENDING_PAYMENT" },
    data: { status: "CANCELLED", cancelledAt: o.now },
  });
  if (moved.count !== 1) {
    throw new Rejected((await tx.order.count({ where: { id: o.orderId, sellerId: o.sellerId } })) ? "invalid_transition" : "not_found");
  }
  await tx.orderStatusHistory.create({
    data: { sellerId: o.sellerId, orderId: o.orderId, fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED", actorType: o.actorType, actorId: o.actorId, reason: o.reason, createdAt: o.now },
  });
  // 주문 때 뺀 재고(ORDER 상품)가 있으면 되돌린다(판매자 설정 restockOnCancel)
  const restocked = await restoreOrderStock(tx, { sellerId: o.sellerId, orderId: o.orderId, reason: "CANCEL", now: o.now, actor: { actorType: o.actorType, actorId: o.actorId } });
  // 쓴 쿠폰은 전체 취소라 되돌린다(shop-coupons)
  await restoreOrderCoupon(tx, { sellerId: o.sellerId, orderId: o.orderId, now: o.now, reason: o.reason });
  // 쓴 적립금은 전부 돌려준다(payments/rewardUse.ts, 대표님 결정 2026-10-05)
  await returnRewardForOrder(tx, { sellerId: o.sellerId, orderId: o.orderId, now: o.now, reason: o.reason });
  await writeAudit(tx, {
    actorType: o.actorType,
    actorId: o.actorId,
    sellerId: o.sellerId,
    action: "order.cancel",
    targetType: "Order",
    targetId: o.orderId,
    reason: o.reason,
    before: { status: "PENDING_PAYMENT" },
    after: { status: "CANCELLED", restockedItems: restocked.length },
  });
  await refreshOrderRetention(tx, o.sellerId, o.now, { orderId: o.orderId });
  return { restockedItems: restocked.length };
}

// 적립금 회수: AUTO면 회수 대기(REVOKE) 기록, MANUAL이면 기록하지 않고 수동 확인 대기로 남긴다
// (환불된 주문에 EARN은 있고 REVOKE가 없는 상태 = 수동 확인 대기). 지급 기록이 없으면 none.
export type RewardRevokeOutcome = "revoked" | "manual_review" | "none";
export type RefundOutcome = {
  orderId: string;
  restockedItemIds: string[];
  cancelledQueueItemIds: string[];
  openedItemCount: number;
  rewardRevoke: RewardRevokeOutcome;
  // 이 주문 상품 리뷰의 적립 회수(revokeMode를 따른다. MANUAL이면 manual_review와 회수할 금액)
  reviewRewardRevoke: ReviewRewardRevoke;
  refundAmount: number;
  refundFault: RefundFault | null;
  returnFeeDeducted: number;
  // 부분 환불(MASTER 배정 2026-10-05): 이번 환불 1건의 id·순번, 주문 전체가 환불로 끝났는지, 함께 돌려준 적립금, 주문 적립 회수액
  refundId: string;
  seq: number;
  isFinal: boolean;
  rewardReturn: number;
  rewardRevokeAmount: number;
};

// 환불액(PRODUCT_SCOPE 「반품·교환 배송비」, 대표님 결정 2026-10-03).
// - 발송 전: 결제 금액 전부(상품 + 배송비). 구매자 사정이면 개봉한 상품은 빼고 돌려준다.
// - 발송 후 판매자 사정(불량·오배송): 상품 + 처음 배송비. 반품 배송비를 받지 않는다.
// - 발송 후 구매자 사정(단순 변심): 개봉하지 않은 상품 − 반품 배송비(편도). 처음 배송비는 돌려주지 않는다.
//   처음 배송비가 0원(무료 배송)이었으면 왕복(편도 × 2)으로 뺀다. 돌려줄 상품이 없으면 빼지 않는다. 0원 아래로 내려가지 않는다.
// - 개봉한 상품은 구매자 사정이면 환불하지 않는다(OPENED_NO_REFUND 동의). 판매자 사정이면 판매자가 확인(confirmOpened)하고 돌려준다.
// - 돈으로 돌려주는 환불액은 실제 결제액(totalAmount, 적립금 사용액을 이미 뺀 금액)을 넘지 않는다.
// - 쓴 적립금(rewardUsed)은 돌아오는 상품 금액 비율만큼 적립금으로 돌려주고(payments/rewardUse.ts rewardReturnAmount, 10원 단위 내림),
//   그만큼 현금에서 뺀다: 현금 + 적립금 반환 = 돌아오는 상품(+배송비) − 반품 배송비(대표님 결정 2026-10-05, 검수 #346).
export function computeRefund(input: {
  // couponDiscount: 그 품목에 배분된 쿠폰 할인(shop-coupons). 품목 환불액 = 단가 × 수량 − 배분액
  items: { unitPrice: number; quantity: number; opened: boolean; couponDiscount?: number }[];
  shippingFee: number;
  totalAmount: number;
  shipped: boolean;
  fault: RefundFault | null;
  returnFee: number;
  rewardUsed?: number;
}): { refundAmount: number; returnFeeDeducted: number; rewardReturn: number } {
  const buyerFault = input.fault === "BUYER";
  const value = (i: (typeof input.items)[number]) => i.unitPrice * i.quantity - (i.couponDiscount ?? 0);
  const items = input.items.reduce((sum, i) => sum + (buyerFault && i.opened ? 0 : value(i)), 0);
  const ordered = input.items.reduce((sum, i) => sum + value(i), 0);
  const rewardReturn = rewardReturnAmount({ rewardUsedAmount: input.rewardUsed ?? 0, items: { refunded: items, ordered } });
  const shipping = !input.shipped || input.fault === "SELLER" ? input.shippingFee : 0;
  const fee = input.shipped && buyerFault && items > 0 ? input.returnFee * (input.shippingFee === 0 ? 2 : 1) : 0;
  const gross = Math.max(0, Math.min(items + shipping - rewardReturn, input.totalAmount));
  const returnFeeDeducted = Math.min(fee, gross);
  return { refundAmount: gross - returnFeeDeducted, returnFeeDeducted, rewardReturn };
}

// 개봉을 시작했거나 마친 주문대기 품목(환불·재고 복구에서 「개봉한 상품」)
const isOpened = (q: Pick<QueueItem, "openingStartedAt" | "status"> | undefined) =>
  !!q && (q.openingStartedAt !== null || q.status === "OPENING" || q.status === "DONE");
// 아직 개봉 순서를 기다리거나 개봉 중인 주문대기 품목(환불하면 카드를 취소한다)
const isQueued = (q: Pick<QueueItem, "status"> | undefined) => !!q && (q.status === "WAITING" || q.status === "OPENING");

// 부분 환불: 환불할 품목과 수량. 없으면 남은 품목 전부.
export type RefundSelection = { orderItemId: string; quantity: number }[];

const refundOrderInclude = {
  items: { orderBy: { createdAt: "asc" as const } },
  queueItems: true,
  shipment: { select: { status: true } },
  couponRedemption: { select: { benefit: true, itemDiscounts: true } },
  refunds: { select: { itemsAmount: true, refundAmount: true, rewardReturn: true, rewardRevoke: true, rewardRevokeKind: true } },
} satisfies Prisma.OrderInclude;
type RefundOrderRow = Prisma.OrderGetPayload<{ include: typeof refundOrderInclude }>;

// 고른 품목·수량을 검사하고 이번 환불을 계산한다(미리보기·환불 공통).
// - 같은 품목을 두 번, 주문에 없는 품목, 남은 수량을 넘는 수량, 1 미만 → invalid_refund_items
// - 개봉 순서를 기다리거나 개봉 중인 품목(주문대기 카드 1장 = 품목 전체)은 수량 일부만 환불할 수 없다 → queued_item_partial
function planRefund(order: RefundOrderRow, o: { fault: RefundFault | null; returnFee: number; selection?: RefundSelection }) {
  const remaining = new Map(order.items.map((i) => [i.id, i.quantity - i.refundedQuantity]));
  const select = new Map<string, number>();
  if (o.selection === undefined) {
    for (const [id, left] of remaining) if (left > 0) select.set(id, left);
  } else {
    for (const s of o.selection) {
      const left = remaining.get(s.orderItemId);
      if (left === undefined || select.has(s.orderItemId) || !Number.isSafeInteger(s.quantity) || s.quantity < 1 || s.quantity > left) {
        return { ok: false as const, reason: "invalid_refund_items" as const };
      }
      select.set(s.orderItemId, s.quantity);
    }
  }
  // 고른 품목이 없으면 거절. 고르지 않았는데 남은 품목이 없으면(품목 없는 주문) 지금처럼 주문 전체 환불로 처리한다
  if (select.size === 0 && o.selection !== undefined) return { ok: false as const, reason: "invalid_refund_items" as const };
  const queueOf = (id: string) => order.queueItems.find((x) => x.orderItemId === id);
  for (const [id, n] of select) if (isQueued(queueOf(id)) && n < (remaining.get(id) ?? 0)) return { ok: false as const, reason: "queued_item_partial" as const };
  const calcItems: RefundCalcItem[] = order.items.map((i) => ({
    id: i.id,
    unitPrice: i.unitPrice,
    quantity: i.quantity,
    couponDiscount: itemCouponDiscount(order.couponRedemption, i.optionId),
    opened: isOpened(queueOf(i.id)),
    refundedQuantity: i.refundedQuantity,
    select: select.get(i.id) ?? 0,
  }));
  const history = order.refunds.reduce((a, r) => ({ itemsAmount: a.itemsAmount + r.itemsAmount, cash: a.cash + r.refundAmount, rewardReturn: a.rewardReturn + r.rewardReturn }), { itemsAmount: 0, cash: 0, rewardReturn: 0 });
  const shipped = order.shipment !== null;
  const step = computeRefundStep({
    items: calcItems,
    // 배송비 무료 쿠폰을 썼으면 구매자가 낸 배송비는 0원(shop-coupons chargedShippingFee)
    shippingFee: chargedShippingFee(order),
    totalAmount: order.totalAmount,
    shipped,
    fault: o.fault,
    returnFee: o.returnFee,
    rewardUsed: order.rewardUsedAmount,
    history,
  });
  const openedSelected = calcItems.filter((i) => i.select > 0 && i.opened).length;
  return { ok: true as const, calcItems, step, shipped, openedSelected, history };
}

// 주문 적립 회수(이번 몫). 적립이 기록됐으면 회수 원장(AUTO) 또는 수동 확인(MANUAL), 배송 완료 적립이 아직 기록 전이면 적립 예정액에서 뺀다(pending).
// 앞선 부분 환불의 pending 몫은 원래 적립 총액에 더해 비율을 계산한다.
type EarnRevokePlan = { amount: number; kind: "ledger" | "manual" | "pending" | null; earn: { buyerMemberId: string; testMode: boolean } | null };
async function planEarnRevoke(db: Tx | PrismaClient, sellerId: string, order: RefundOrderRow, calcItems: RefundCalcItem[], isFinal: boolean): Promise<EarnRevokePlan> {
  const revokedBefore = order.refunds.reduce((a, r) => a + r.rewardRevoke, 0);
  const pendingBefore = order.refunds.reduce((a, r) => a + (r.rewardRevokeKind === "pending" ? r.rewardRevoke : 0), 0);
  const earn = await db.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId, idempotencyKey: `earn:${order.id}` } }, select: { amount: true, buyerMemberId: true, testMode: true } });
  if (earn) {
    const amount = earnRevokeStep({ earnTotal: earn.amount + pendingBefore, items: calcItems, isFinal, revokedBefore });
    const policy = await db.rewardPolicy.findUnique({ where: { sellerId }, select: { revokeMode: true } });
    return { amount, kind: amount > 0 ? (policy?.revokeMode === "MANUAL" ? "manual" : "ledger") : null, earn };
  }
  if (order.rewardEarnTiming === "ON_DELIVERY" && (order.rewardEarnAmount ?? 0) > 0) {
    const amount = earnRevokeStep({ earnTotal: (order.rewardEarnAmount ?? 0) + pendingBefore, items: calcItems, isFinal, revokedBefore });
    return { amount, kind: amount > 0 ? "pending" : null, earn: null };
  }
  return { amount: 0, kind: null, earn: null };
}

export type RefundPreviewItem = {
  orderItemId: string;
  productName: string;
  optionName: string;
  quantity: number;
  refundedQuantity: number;
  // 아직 환불하지 않은 수량
  refundableQuantity: number;
  opened: boolean;
  // 개봉 순서를 기다리거나 개봉 중(수량 일부만 환불할 수 없다)
  queued: boolean;
  // 남은 수량 전부를 환불할 때의 품목 금액(쿠폰 배분 뺀 값)
  refundableAmount: number;
};

export type RefundPreview = {
  shipped: boolean;
  // 구매자가 실제로 낸 처음 배송비(배송비 무료 쿠폰이면 0). 화면의 공제 항목은 이 값을 쓴다.
  chargedShippingFee: number;
  openedItems: { orderItemId: string; amount: number }[];
  // 사유 주체별 환불액. blocked: 이 사유 주체로는 환불할 수 없다(refundOrder가 opened_items_unshipped로 막는다)
  // rewardReturn: 함께 돌려주는 적립금(현금 환불액에는 들어 있지 않음). itemsAmount·shippingRefunded: 이번에 돌려받는 상품 금액·배송비
  byFault: Record<RefundFault, { refundAmount: number; returnFeeDeducted: number; rewardReturn: number; itemsAmount: number; shippingRefunded: number; blocked: boolean }>;
  // 부분 환불: 품목별 남은 수량, 이번 환불이 주문 전체를 끝내는지, 이미 돌려준 현금 합
  items: RefundPreviewItem[];
  isFinal: boolean;
  refundedAmount: number;
  // 회수할 주문 적립(ledger: 회수 원장, manual: 판매자 수동 확인, pending: 아직 지급 전 적립 예정액에서 뺌, null: 없음)
  rewardRevoke: { amount: number; kind: EarnRevokePlan["kind"] };
};

// 환불 미리보기(계산만, 상태 변경 없음). refundOrder와 같은 계산(planRefund)을 쓴다. 결제 완료 주문만 돌려주고, 그 밖에는 null.
export async function previewRefund(db: PrismaClient, ctx: TenantContext, orderId: string): Promise<RefundPreview | null> {
  const r = await previewRefundSelection(db, ctx, orderId);
  return r.ok ? r.value : null;
}

// 고른 품목·수량으로 미리보기(SA-023 부분 환불). 잘못 고르면 refundOrder와 같은 거부 사유.
export async function previewRefundSelection(
  db: PrismaClient,
  ctx: TenantContext,
  orderId: string,
  selection?: RefundSelection,
): Promise<{ ok: true; value: RefundPreview } | { ok: false; reason: "not_found" | "invalid_refund_items" | "queued_item_partial" }> {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const order = await db.order.findFirst({ where: { id: orderId, sellerId: ctx.sellerId, status: "PAID" }, include: refundOrderInclude });
  if (!order) return { ok: false, reason: "not_found" };
  const returnFee = order.returnFeeSnapshot ?? (await getShippingPolicy(db, ctx.sellerId)).returnFee;
  const byFault = {} as RefundPreview["byFault"];
  let base: Extract<ReturnType<typeof planRefund>, { ok: true }> | null = null;
  for (const fault of ["BUYER", "SELLER"] as const) {
    const p = planRefund(order, { fault, returnFee, selection });
    if (!p.ok) return p;
    base = p;
    const { refundAmount, returnFeeDeducted, rewardReturn, itemsAmount, shippingRefunded } = p.step;
    byFault[fault] = { refundAmount, returnFeeDeducted, rewardReturn, itemsAmount, shippingRefunded, blocked: fault === "BUYER" && !p.shipped && p.openedSelected > 0 };
  }
  const plan = base!;
  const revoke = await planEarnRevoke(db, ctx.sellerId, order, plan.calcItems, plan.step.isFinal);
  return {
    ok: true,
    value: {
      shipped: plan.shipped,
      chargedShippingFee: chargedShippingFee(order),
      openedItems: plan.calcItems.filter((i) => i.opened).map((i) => ({ orderItemId: i.id, amount: i.unitPrice * i.quantity - i.couponDiscount })),
      byFault,
      items: order.items.map((i, k) => {
        const c = plan.calcItems[k];
        const q = order.queueItems.find((x) => x.orderItemId === i.id);
        return {
          orderItemId: i.id,
          productName: i.productNameSnapshot,
          optionName: i.optionNameSnapshot,
          quantity: i.quantity,
          refundedQuantity: i.refundedQuantity,
          refundableQuantity: i.quantity - i.refundedQuantity,
          opened: c.opened,
          queued: isQueued(q),
          refundableAmount: itemValue(c, i.quantity) - itemValue(c, i.refundedQuantity),
        };
      }),
      isFinal: plan.step.isFinal,
      refundedAmount: plan.history.cash,
      rewardRevoke: { amount: revoke.amount, kind: revoke.kind },
    },
  };
}

// 결제 완료 주문 환불(부분 환불 포함): 고른 품목·수량(없으면 남은 품목 전부)을 돌려준다. 남은 품목을 모두 돌려주는 환불이면 결제 완료 → 환불로 바꾼다.
// 이번 환불로 다 돌려준 품목마다
// - 연결된 주문대기가 「대기」·「개봉 중」이면 자동 취소
// - 발송 전이고 개봉 전이면 재고 복구(품목 단위, 판매자 설정). 수량 일부만 돌려준 품목은 다 돌려줄 때 한꺼번에 복구한다(그 전에 발송·반품되면 반품 회수가 복구)
// 판매자 주문 잠금 아래에서 주문 행을 잡고 실시간 version을 확인하므로 같은 주문을 동시에 두 번 환불하지 않는다.
// 개봉을 시작했거나 마친 품목을 고르면 confirmOpened가 있어야 한다.
export async function refundOrder(
  db: PrismaClient,
  ctx: TenantContext,
  orderId: string,
  opts: {
    reason?: string;
    expectedLiveVersion: number;
    confirmOpened?: boolean;
    fault?: RefundFault;
    expectedRefundAmount?: number;
    items?: RefundSelection;
    // 구매자 환불 요청 승인(payments/refundRequest.ts): 그 요청이 진행 중이어야 하고, 같은 트랜잭션에서 승인으로 닫는다
    refundRequestId?: string;
    now?: Date;
  },
): Promise<QueueResult<RefundOutcome>> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!opts.reason?.trim()) return { ok: false, reason: "reason_required" };
  const reason = opts.reason.trim();
  return run(db, ctx.sellerId, async (tx, version) => {
    if (version - 1 !== opts.expectedLiveVersion) throw new Rejected("conflict");
    // 주문 생성과 같은 잠금을 주문 행·재고 행보다 먼저 잡는다. 주문 생성은 이 잠금 → 재고 행 순서라, 재고를 되돌린 뒤에
    // 잡으면 같은 옵션 주문과 교착한다. 구매 제한 횟수(아래 maybeRestrict)도 이 잠금 아래에서 센다.
    await lockSellerOrders(tx, ctx.sellerId);
    // 잠금을 잡은 뒤 판매자 시계로 찍는다(now()는 트랜잭션 시작 시각이라 기다리는 사이 켠 설정·푼 제한보다 이를 수 있고,
    // DB 시계만 쓰면 같은 밀리초에 순서가 뒤집힐 수 있다).
    const now = opts.now ?? (await sellerEventClock(tx, ctx.sellerId));
    // 주문 행 잠금(리뷰 적립 회수 등이 이 잠금 뒤 회원 → 리뷰 → 원장 순서로 잡는다)
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS "status" FROM "Order" WHERE "id" = ${orderId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR NO KEY UPDATE`;
    if (locked.length === 0) throw new Rejected("not_found");
    if (locked[0].status !== "PAID") throw new Rejected("invalid_transition");
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: refundOrderInclude });
    // 구매 확정한 주문은 바로 환불하지 않는다. 판매자가 구매 확정을 먼저 취소해야 한다(대표님 결정 2026-10-03, orders/delivery.ts unconfirmPurchase).
    if (order.purchaseConfirmedAt) throw new Rejected("purchase_confirmed");
    const returnFee = order.returnFeeSnapshot ?? (await getShippingPolicy(tx, ctx.sellerId)).returnFee;
    const refundFault = opts.fault ?? null;
    const plan = planRefund(order, { fault: refundFault, returnFee, selection: opts.items });
    if (!plan.ok) throw new Rejected(plan.reason);
    // 발송한 주문은 상품이 구매자에게 가 있으므로 재고를 되돌리지 않는다(회수는 판매자가 MANUAL로). 배송 기록은 그대로 둔다.
    const shippedBeforeRefund = plan.shipped;
    const openedItemCount = plan.openedSelected;
    if (openedItemCount > 0 && opts.confirmOpened !== true) throw new Rejected("opened_items_present");
    // 발송했거나 개봉한 품목이 있으면 환불액이 사유 주체(구매자·판매자 사정)에 따라 달라지므로 꼭 받는다
    if ((shippedBeforeRefund || openedItemCount > 0) && !opts.fault) throw new Rejected("fault_required");
    // 발송 전 주문에서 개봉한 품목을 구매자 사정으로 고르면 막는다(그 품목 값을 안 돌려주면서 상품도 안 보내게 되기 때문, MASTER 결정 2026-10-03).
    // 개봉하지 않은 품목만 골라 부분 환불하는 것은 된다(개봉한 품목은 그대로 보낸다). 판매자 사정은 돌려준다.
    if (!shippedBeforeRefund && openedItemCount > 0 && refundFault === "BUYER") throw new Rejected("opened_items_unshipped");
    const { refundAmount, returnFeeDeducted, rewardReturn, isFinal } = plan.step;
    // 화면에서 확인받은 금액과 다르면(그사이 발송·개봉·다른 부분 환불 등) 아무것도 바꾸지 않고 되돌린다
    if (opts.expectedRefundAmount !== undefined && opts.expectedRefundAmount !== refundAmount) throw new Rejected("refund_amount_changed");

    const seq = order.refunds.length + 1;
    // 한 번에 주문 전체를 환불하면 지금까지와 같은 멱등 키, 나눠 환불하면 환불마다 다른 키
    const single = seq === 1 && isFinal;
    const keySuffix = single ? orderId : `${orderId}:${seq}`;
    const revoke = await planEarnRevoke(tx, ctx.sellerId, order, plan.calcItems, isFinal);
    const refund = await tx.orderRefund.create({
      data: {
        sellerId: ctx.sellerId,
        orderId,
        seq,
        fault: refundFault,
        reason,
        items: plan.step.lines,
        itemsAmount: plan.step.itemsAmount,
        shippingRefunded: plan.step.shippingRefunded,
        refundAmount,
        returnFeeDeducted,
        rewardReturn,
        rewardRevoke: revoke.amount,
        rewardRevokeKind: revoke.kind,
        isFinal,
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        createdAt: now,
      },
    });
    // 구매자 환불 요청: 승인으로 한 환불이면 그 요청을, 남은 품목을 모두 돌려준 환불이면 진행 중인 요청을 승인으로 닫는다
    const settled = await settleRefundRequestsOnRefund(tx, {
      sellerId: ctx.sellerId,
      orderId,
      refundId: refund.id,
      isFinal,
      requestId: opts.refundRequestId,
      now,
      actor: { actorType: ctx.actorType, actorId: ctx.actorId },
    });
    if (!settled) throw new Rejected("invalid_transition");
    for (const l of plan.step.lines) await tx.orderItem.update({ where: { id: l.orderItemId }, data: { refundedQuantity: { increment: l.quantity } } });
    await tx.order.update({
      where: { id: orderId },
      data: {
        refundAmount: plan.history.cash + refundAmount,
        refundFault,
        returnFeeDeducted: order.refunds.length ? { increment: returnFeeDeducted } : returnFeeDeducted,
        ...(isFinal ? { status: "REFUNDED" as const, refundedAt: now } : {}),
        ...(revoke.kind === "pending" ? { rewardEarnAmount: { decrement: revoke.amount } } : {}),
      },
    });
    // 카드 결제 주문이면 환불액만큼 PG 취소 요청을 같은 트랜잭션에 남긴다(PG 호출은 커밋 뒤, payments/service.ts)
    await requestPaymentCancel(tx, { sellerId: ctx.sellerId, orderId, amount: refundAmount, reason, idempotencyKey: `refund:${keySuffix}` });
    // 쓴 적립금 반환(payments/rewardUse.ts): 계산한 금액(현금 환불액에서 이미 뺀 몫)
    await returnRewardForOrder(tx, { sellerId: ctx.sellerId, orderId, amount: rewardReturn, now, reason, idempotencyKey: `use_return:${keySuffix}` });
    // 결제 금액 전부를 돌려주면 전체 취소로 보고 쓴 쿠폰을 되돌린다. 일부만 돌려주면 되돌리지 않는다(MASTER 2026-10-04).
    // 개봉한 품목을 구매자 사정으로 남기는 환불은 금액이 결제 금액과 같아도 전체 취소가 아니다(Codex 4176403238).
    const ordered = plan.calcItems.reduce((a, i) => a + itemValue(i, i.quantity), 0);
    const keepsItems = plan.history.itemsAmount + plan.step.itemsAmount < ordered;
    if (isFinal && plan.history.cash + refundAmount === order.totalAmount && !keepsItems) await restoreOrderCoupon(tx, { sellerId: ctx.sellerId, orderId, now, reason: "refund_full" });
    if (isFinal) {
      await tx.orderStatusHistory.create({
        data: { sellerId: ctx.sellerId, orderId, fromStatus: "PAID", toStatus: "REFUNDED", actorType: ctx.actorType, actorId: ctx.actorId, reason, createdAt: now },
      });
    }

    // 이번 환불로 다 돌려준 품목
    const completed = plan.calcItems.filter((i) => i.select > 0 && i.refundedQuantity + i.select >= i.quantity);
    const restockedItemIds: string[] = [];
    const restoreCandidateIds: string[] = [];
    const cancelledQueueItemIds: string[] = [];
    for (const item of completed) {
      const q = order.queueItems.find((x) => x.orderItemId === item.id);
      if (q && isQueued(q)) {
        await tx.queueItem.update({
          where: { id: q.id },
          data: { status: "CANCELLED", cancelledAt: now, cancelReason: `환불: ${reason}`, version: { increment: 1 } },
        });
        await tx.queueItemStatusHistory.create({
          data: { sellerId: ctx.sellerId, queueItemId: q.id, fromStatus: q.status, toStatus: "CANCELLED", actorType: ctx.actorType, actorId: ctx.actorId, reason: `환불: ${reason}`, createdAt: now },
        });
        cancelledQueueItemIds.push(q.id);
      }
      // 발송 후 환불·개봉한 품목은 되돌리지 않는다. 그 밖에는 실제로 재고를 뺀 품목만 되돌린다(판매자 설정 restockOnCancel).
      if (shippedBeforeRefund) continue;
      if (q && isOpened(q)) continue;
      restoreCandidateIds.push(item.id);
    }
    if (restoreCandidateIds.length) {
      restockedItemIds.push(
        ...(await restoreOrderStock(tx, {
          sellerId: ctx.sellerId,
          orderId,
          reason: "REFUND",
          now,
          actor: { actorType: ctx.actorType, actorId: ctx.actorId },
          itemIds: restoreCandidateIds,
        })),
      );
    }

    // 주문 적립 회수(이번 몫, 한 번만). 회수 방식이 MANUAL이면 자동 기록하지 않는다(수동 확인 대기). 기록 전 적립 예정액은 위에서 줄였다.
    const rewardRevoke: RewardRevokeOutcome = revoke.kind === "ledger" ? "revoked" : revoke.kind === "manual" ? "manual_review" : "none";
    if (revoke.kind === "ledger" && revoke.earn) {
      // 탈퇴한 회원이면 FAILED(member_withdrawn)로 남는다(잔액은 탈퇴 때 이미 소멸)
      await createPendingRewardLedger(tx, {
        sellerId: ctx.sellerId,
        buyerMemberId: revoke.earn.buyerMemberId,
        orderId,
        type: "REVOKE",
        amount: -revoke.amount,
        testMode: revoke.earn.testMode,
        idempotencyKey: `revoke:${keySuffix}`,
        createdAt: now,
      });
    }
    // 다 돌려준 품목의 상품 리뷰 적립도 같은 회수 방식으로 회수한다(주문 잠금 뒤 회원 → 리뷰 → 원장, product-reviews/service.ts)
    const reviewRewardRevoke = await revokeReviewRewardsForOrder(tx, ctx.sellerId, orderId, now, isFinal ? undefined : completed.map((i) => i.id));
    // 주문 전체 환불이면 이 주문의 진행 중인 교환·반품 신청을 닫는다(shop-returns: 반품 회수 완료분은 완료, 그 밖은 철회)
    if (isFinal) await closeReturnsOnRefund(tx, { sellerId: ctx.sellerId, orderId, refundAmount, now, actor: { actorType: ctx.actorType, actorId: ctx.actorId } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: isFinal ? "order.refund" : "order.refund_partial",
      targetType: "Order",
      targetId: orderId,
      reason,
      before: { status: "PAID" },
      after: {
        status: isFinal ? "REFUNDED" : "PAID",
        refundId: refund.id,
        seq,
        items: plan.step.lines,
        restockedItems: restockedItemIds.length,
        cancelledQueueItems: cancelledQueueItemIds.length,
        openedItems: openedItemCount,
        rewardRevoke,
        rewardRevokeAmount: revoke.amount,
        reviewRewardRevoke,
        shippedBeforeRefund,
        refundAmount,
        refundFault,
        returnFeeDeducted,
        rewardReturn,
        ...(order.shipment ? { shipmentStatus: order.shipment.status } : {}),
      },
    });
    if (isFinal) {
      // 「결제 후 취소 5회 → 30일」(판매자 설정, 기본 꺼짐). 맨 앞에서 잡은 주문 생성 잠금 아래에서 센다.
      await maybeRestrict(tx, ctx.sellerId, order.buyerMemberId, now, "paid_cancel");
      // 끝난 날이 바뀌었으니 보관 만료일을 다시 계산하고(구매 확정 뒤 환불 포함), 탈퇴한 회원의 주문이면 분리 보관 표시를 단다(buyers/legalHold.ts)
      await refreshOrderRetention(tx, ctx.sellerId, now, { orderId });
    }
    return {
      orderId,
      restockedItemIds,
      cancelledQueueItemIds,
      openedItemCount,
      rewardRevoke,
      reviewRewardRevoke,
      refundAmount,
      refundFault,
      returnFeeDeducted,
      refundId: refund.id,
      seq,
      isFinal,
      rewardReturn,
      rewardRevokeAmount: revoke.amount,
    };
  });
}

