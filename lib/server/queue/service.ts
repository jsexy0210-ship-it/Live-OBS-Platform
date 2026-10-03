import { Prisma, type ActorType, type PaymentMethod, type PrismaClient, type QueueItem, type RefundFault } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notifySellerChanged } from "../realtime/notify";
import { lockSellerOrders, maybeRestrict, sellerEventClock } from "../orders/overdue";
import { getShippingPolicy } from "../orders/shipping";
import { earnQuote } from "../rewards/earn";
import { createPendingRewardLedger } from "../rewards/ledger";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { restoreOrderStock } from "../products/stock";
import { checkTransition, isCompletePermutation, isValidTimer, type QueueAction, type QueueRejection } from "./rules";
import { refreshOrderRetention } from "../buyers/legalHold";

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
        actorId: ctx.actorId,
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
  input: { now?: Date } = {},
): Promise<QueueResult<{ broadcastSessionId: string; carriedOver: number }>> {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const now = input.now ?? new Date();
  return run(db, ctx.sellerId, async (tx) => {
    const live = await tx.broadcastSession.findFirst({ where: { sellerId: ctx.sellerId, status: "LIVE" } });
    if (!live) throw new Rejected("not_live");
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
      actorId: ctx.actorId,
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
          base: rewardBase(order.items),
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
    include: { items: { orderBy: { createdAt: "asc" } }, buyerMember: { include: { grade: true } } },
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
  refundAmount: number;
  refundFault: RefundFault | null;
  returnFeeDeducted: number;
};

// 환불액(PRODUCT_SCOPE 「반품·교환 배송비」, 대표님 결정 2026-10-03).
// - 발송 전: 결제 금액 전부(상품 + 배송비). 구매자 사정이면 개봉한 상품은 빼고 돌려준다.
// - 발송 후 판매자 사정(불량·오배송): 상품 + 처음 배송비. 반품 배송비를 받지 않는다.
// - 발송 후 구매자 사정(단순 변심): 개봉하지 않은 상품 − 반품 배송비(편도). 처음 배송비는 돌려주지 않는다.
//   처음 배송비가 0원(무료 배송)이었으면 왕복(편도 × 2)으로 뺀다. 돌려줄 상품이 없으면 빼지 않는다. 0원 아래로 내려가지 않는다.
// - 개봉한 상품은 구매자 사정이면 환불하지 않는다(OPENED_NO_REFUND 동의). 판매자 사정이면 판매자가 확인(confirmOpened)하고 돌려준다.
// - 돈으로 돌려주는 환불액은 실제 결제액(totalAmount, 적립금 사용액을 이미 뺀 금액)을 넘지 않는다.
//   쓴 적립금을 되돌리는 규칙은 아직 없다(PRODUCT_SCOPE 「적립금 사용(결제 차감) 방식」 미정). 지금은 주문에서 적립금을 쓸 수 없다.
export function computeRefund(input: {
  items: { unitPrice: number; quantity: number; opened: boolean }[];
  shippingFee: number;
  totalAmount: number;
  shipped: boolean;
  fault: RefundFault | null;
  returnFee: number;
}): { refundAmount: number; returnFeeDeducted: number } {
  const buyerFault = input.fault === "BUYER";
  const items = input.items.reduce((sum, i) => sum + (buyerFault && i.opened ? 0 : i.unitPrice * i.quantity), 0);
  const shipping = !input.shipped || input.fault === "SELLER" ? input.shippingFee : 0;
  const fee = input.shipped && buyerFault && items > 0 ? input.returnFee * (input.shippingFee === 0 ? 2 : 1) : 0;
  const gross = Math.min(items + shipping, input.totalAmount);
  const returnFeeDeducted = Math.min(fee, Math.max(0, gross));
  return { refundAmount: Math.max(0, gross - returnFeeDeducted), returnFeeDeducted };
}

// 개봉을 시작했거나 마친 주문대기 품목(환불·재고 복구에서 「개봉한 상품」)
const isOpened = (q: Pick<QueueItem, "openingStartedAt" | "status"> | undefined) =>
  !!q && (q.openingStartedAt !== null || q.status === "OPENING" || q.status === "DONE");

export type RefundPreview = {
  shipped: boolean;
  openedItems: { orderItemId: string; amount: number }[];
  // 사유 주체별 환불액. blocked: 이 사유 주체로는 환불할 수 없다(refundOrder가 opened_items_unshipped로 막는다)
  byFault: Record<RefundFault, { refundAmount: number; returnFeeDeducted: number; blocked: boolean }>;
};

// 환불 미리보기(계산만, 상태 변경 없음). refundOrder와 같은 개봉 판정·반품 배송비·computeRefund를 쓴다.
// 결제 완료 주문만 돌려주고, 그 밖에는 null.
export async function previewRefund(db: PrismaClient, ctx: TenantContext, orderId: string): Promise<RefundPreview | null> {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const order = await db.order.findFirst({
    where: { id: orderId, sellerId: ctx.sellerId, status: "PAID" },
    include: { items: true, queueItems: true, shipment: { select: { status: true } } },
  });
  if (!order) return null;
  const shipped = order.shipment !== null;
  const items = order.items.map((i) => ({ id: i.id, unitPrice: i.unitPrice, quantity: i.quantity, opened: isOpened(order.queueItems.find((x) => x.orderItemId === i.id)) }));
  const returnFee = order.returnFeeSnapshot ?? (await getShippingPolicy(db, ctx.sellerId)).returnFee;
  const byFault = {} as RefundPreview["byFault"];
  for (const fault of ["BUYER", "SELLER"] as const) {
    const r = computeRefund({ items, shippingFee: order.shippingFee, totalAmount: order.totalAmount, shipped, fault, returnFee });
    byFault[fault] = { ...r, blocked: fault === "BUYER" && !shipped && items.some((i) => i.opened) };
  }
  return { shipped, openedItems: items.filter((i) => i.opened).map((i) => ({ orderItemId: i.id, amount: i.unitPrice * i.quantity })), byFault };
}

// 결제 완료 주문 환불: 결제 완료 → 환불. 주문 품목마다
// - 연결된 주문대기가 「대기」·「개봉 중」이면 자동 취소
// - 개봉 전(대기였거나 개봉 전에 취소됨)이면 재고 복구, 개봉을 시작했거나 완료했으면 복구 안 함
// - 재고 부족으로 차감되지 않은 주문은 복구할 것 없음
// 주문 상태를 원자적으로 바꾸므로 같은 주문을 두 번 환불하거나 재고를 두 번 복구하지 않는다.
// 개봉을 시작했거나 마친 품목이 있어도 환불할 수 있지만(배송 사고·판매자 판단), confirmOpened가 있어야 한다.
export async function refundOrder(
  db: PrismaClient,
  ctx: TenantContext,
  orderId: string,
  opts: { reason?: string; expectedLiveVersion: number; confirmOpened?: boolean; fault?: RefundFault; expectedRefundAmount?: number; now?: Date },
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
    const moved = await tx.order.updateMany({
      where: { id: orderId, sellerId: ctx.sellerId, status: "PAID" },
      data: { status: "REFUNDED", refundedAt: now },
    });
    if (moved.count !== 1) {
      throw new Rejected((await tx.order.count({ where: { id: orderId, sellerId: ctx.sellerId } })) ? "invalid_transition" : "not_found");
    }
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, queueItems: true, shipment: { select: { status: true } } } });
    // 발송한 주문은 상품이 구매자에게 가 있으므로 재고를 되돌리지 않는다(회수는 판매자가 MANUAL로). 배송 기록은 그대로 둔다.
    const shippedBeforeRefund = order.shipment !== null;
    const openedItemCount = order.items.filter((i) => isOpened(order.queueItems.find((x) => x.orderItemId === i.id))).length;
    // 트랜잭션을 되돌리므로 주문 상태도 결제 완료로 남는다
    if (openedItemCount > 0 && opts.confirmOpened !== true) throw new Rejected("opened_items_present");
    // 발송했거나 개봉한 품목이 있으면 환불액이 사유 주체(구매자·판매자 사정)에 따라 달라지므로 꼭 받는다
    if ((shippedBeforeRefund || openedItemCount > 0) && !opts.fault) throw new Rejected("fault_required");
    const refundFault = opts.fault ?? null;
    // 발송 전 주문에 개봉 품목이 있으면 구매자 사정 환불을 막는다. 개봉 품목 값을 안 돌려주면서 상품도 안 보내게 되기 때문
    // (부분 환불 구조가 생길 때까지 임시, MASTER 결정 2026-10-03). 판매자 사정은 전액 환불.
    if (!shippedBeforeRefund && openedItemCount > 0 && refundFault === "BUYER") throw new Rejected("opened_items_unshipped");
    const returnFee = order.returnFeeSnapshot ?? (await getShippingPolicy(tx, ctx.sellerId)).returnFee;
    const { refundAmount, returnFeeDeducted } = computeRefund({
      items: order.items.map((i) => ({ unitPrice: i.unitPrice, quantity: i.quantity, opened: isOpened(order.queueItems.find((x) => x.orderItemId === i.id)) })),
      shippingFee: order.shippingFee,
      totalAmount: order.totalAmount,
      shipped: shippedBeforeRefund,
      fault: refundFault,
      returnFee,
    });
    // 화면에서 확인받은 금액과 다르면(그사이 발송·개봉 등) 아무것도 바꾸지 않고 되돌린다
    if (opts.expectedRefundAmount !== undefined && opts.expectedRefundAmount !== refundAmount) throw new Rejected("refund_amount_changed");
    await tx.order.update({ where: { id: orderId }, data: { refundAmount, refundFault, returnFeeDeducted } });
    await tx.orderStatusHistory.create({
      data: { sellerId: ctx.sellerId, orderId, fromStatus: "PAID", toStatus: "REFUNDED", actorType: ctx.actorType, actorId: ctx.actorId, reason, createdAt: now },
    });

    const restockedItemIds: string[] = [];
    const restoreCandidateIds: string[] = [];
    const cancelledQueueItemIds: string[] = [];
    for (const item of order.items) {
      const q = order.queueItems.find((x) => x.orderItemId === item.id);
      if (q && (q.status === "WAITING" || q.status === "OPENING")) {
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

    // 적립금 회수(지급 기록이 있을 때만, 한 번만). 회수 방식이 MANUAL이면 자동 기록하지 않는다.
    const earn = await tx.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId: ctx.sellerId, idempotencyKey: `earn:${orderId}` } } });
    const policy = earn ? await tx.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { revokeMode: true } }) : null;
    const rewardRevoke: RewardRevokeOutcome = !earn ? "none" : policy?.revokeMode === "MANUAL" ? "manual_review" : "revoked";
    if (earn && rewardRevoke === "revoked") {
      // 탈퇴한 회원이면 FAILED(member_withdrawn)로 남는다(잔액은 탈퇴 때 이미 소멸)
      await createPendingRewardLedger(tx, {
        sellerId: ctx.sellerId,
        buyerMemberId: earn.buyerMemberId,
        orderId,
        type: "REVOKE",
        amount: -earn.amount,
        testMode: earn.testMode,
        idempotencyKey: `revoke:${orderId}`,
        createdAt: now,
      });
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "order.refund",
      targetType: "Order",
      targetId: orderId,
      reason,
      before: { status: "PAID" },
      after: {
        status: "REFUNDED",
        restockedItems: restockedItemIds.length,
        cancelledQueueItems: cancelledQueueItemIds.length,
        openedItems: openedItemCount,
        rewardRevoke,
        shippedBeforeRefund,
        refundAmount,
        refundFault,
        returnFeeDeducted,
        ...(order.shipment ? { shipmentStatus: order.shipment.status } : {}),
      },
    });
    // 「결제 후 취소 5회 → 30일」(판매자 설정, 기본 꺼짐). 맨 앞에서 잡은 주문 생성 잠금 아래에서 센다.
    await maybeRestrict(tx, ctx.sellerId, order.buyerMemberId, now, "paid_cancel");
    // 끝난 날이 바뀌었으니 보관 만료일을 다시 계산하고(구매 확정 뒤 환불 포함), 탈퇴한 회원의 주문이면 분리 보관 표시를 단다(buyers/legalHold.ts)
    await refreshOrderRetention(tx, ctx.sellerId, now, { orderId });
    return { orderId, restockedItemIds, cancelledQueueItemIds, openedItemCount, rewardRevoke, refundAmount, refundFault, returnFeeDeducted };
  });
}

