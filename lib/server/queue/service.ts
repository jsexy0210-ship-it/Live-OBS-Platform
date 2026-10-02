import { Prisma, type PaymentMethod, type PrismaClient, type QueueItem } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notifySellerChanged } from "../realtime/notify";
import { earnAmount } from "../rewards/earn";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { checkTransition, isCompletePermutation, isValidTimer, type QueueAction, type QueueRejection } from "./rules";

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

// 결제 완료 처리(이번 단계는 내부 함수, PG 연동 전). 전 품목 재고 차감을 한 트랜잭션에서 하고,
// 하나라도 모자라면 모두 되돌린 뒤 주문에 stockShortageAt만 기록한다(주문대기·적립 원장 없음).
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
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: now, paymentMethod } });
      await tx.orderStatusHistory.create({
        data: { sellerId, orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", ...system, createdAt: now },
      });

      for (const item of order.items) {
        const dec = await tx.productOption.updateMany({
          where: { id: item.optionId, sellerId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (dec.count === 0) throw new StockShortage();
        await tx.stockMovement.create({
          data: { sellerId, optionId: item.optionId, delta: -item.quantity, reason: "ORDER", orderId, ...system, createdAt: now },
        });
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
      // 적립금 지급 대기 기록(실지급 스위치가 꺼져 있으면 testMode). 지급·잔액 반영은 다음 단계.
      // 적립 기준액 = 상품 결제 금액(주문 품목 단가 × 수량 합, 배송비 제외) − 적립금 사용액. totalAmount는 쓰지 않는다.
      const policy = await tx.rewardPolicy.findUnique({ where: { sellerId } });
      const amount = policy
        ? earnAmount({
            rates: policy.rates,
            earnStartsAt: policy.earnStartsAt,
            gradeId: order.buyerMember.gradeId,
            paymentMethod,
            base: rewardBase(order.items, order.rewardUsedAmount),
            now,
          })
        : 0;
      if (policy && amount > 0) {
        await tx.rewardLedger.create({
          data: {
            sellerId,
            buyerMemberId: order.buyerMemberId,
            orderId,
            type: "EARN",
            amount,
            status: "PENDING",
            testMode: !policy.livePayoutEnabled,
            idempotencyKey: `earn:${orderId}`,
            createdAt: now,
          },
        });
      }
      await writeAudit(tx, { ...system, sellerId, action: "order.paid", targetType: "Order", targetId: orderId });
      return { orderId, stockShortage: false, queueItemIds };
    });
  } catch (e) {
    if (!(e instanceof StockShortage)) throw e;
  }

  return run(db, sellerId, async (tx) => {
    const order = await loadPendingOrder(tx, sellerId, orderId);
    await tx.order.update({
      where: { id: orderId },
      data: { status: "PAID", paidAt: now, paymentMethod: input.paymentMethod ?? order.paymentMethod, stockShortageAt: now },
    });
    await tx.orderStatusHistory.create({
      data: { sellerId, orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", ...system, reason: "stock_shortage", createdAt: now },
    });
    await writeAudit(tx, { ...system, sellerId, action: "order.stock_shortage", targetType: "Order", targetId: orderId });
    return { orderId, stockShortage: true, queueItemIds: [] };
  });
}

// 적립 기준액: 상품 결제 금액(배송비 제외) − 적립금 사용액(ARCHITECTURE 4.7)
export function rewardBase(items: { unitPrice: number; quantity: number }[], rewardUsedAmount: number): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) - rewardUsedAmount;
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
    const moved = await tx.order.updateMany({
      where: { id: orderId, sellerId: ctx.sellerId, status: "PENDING_PAYMENT" },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    if (moved.count !== 1) {
      throw new Rejected((await tx.order.count({ where: { id: orderId, sellerId: ctx.sellerId } })) ? "invalid_transition" : "not_found");
    }
    await tx.orderStatusHistory.create({
      data: { sellerId: ctx.sellerId, orderId, fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED", actorType: ctx.actorType, actorId: ctx.actorId, reason, createdAt: now },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "order.cancel",
      targetType: "Order",
      targetId: orderId,
      reason,
      before: { status: "PENDING_PAYMENT" },
      after: { status: "CANCELLED" },
    });
    return { orderId };
  });
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
};

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
  opts: { reason?: string; expectedLiveVersion: number; confirmOpened?: boolean; now?: Date },
): Promise<QueueResult<RefundOutcome>> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!opts.reason?.trim()) return { ok: false, reason: "reason_required" };
  const reason = opts.reason.trim();
  return run(db, ctx.sellerId, async (tx, version) => {
    if (version - 1 !== opts.expectedLiveVersion) throw new Rejected("conflict");
    const now = opts.now ?? (await dbNow(tx));
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
    const isOpened = (q: (typeof order.queueItems)[number] | undefined) =>
      !!q && (q.openingStartedAt !== null || q.status === "OPENING" || q.status === "DONE");
    const openedItemCount = order.items.filter((i) => isOpened(order.queueItems.find((x) => x.orderItemId === i.id))).length;
    // 트랜잭션을 되돌리므로 주문 상태도 결제 완료로 남는다
    if (openedItemCount > 0 && opts.confirmOpened !== true) throw new Rejected("opened_items_present");
    await tx.orderStatusHistory.create({
      data: { sellerId: ctx.sellerId, orderId, fromStatus: "PAID", toStatus: "REFUNDED", actorType: ctx.actorType, actorId: ctx.actorId, reason, createdAt: now },
    });

    const restockedItemIds: string[] = [];
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
      if (order.stockShortageAt || shippedBeforeRefund) continue;
      if (!q || isOpened(q)) continue;
      await tx.productOption.update({ where: { id: item.optionId }, data: { stock: { increment: item.quantity } } });
      await tx.stockMovement.create({
        data: { sellerId: ctx.sellerId, optionId: item.optionId, delta: item.quantity, reason: "REFUND", orderId, actorType: ctx.actorType, actorId: ctx.actorId, createdAt: now },
      });
      restockedItemIds.push(item.id);
    }

    // 적립금 회수(지급 기록이 있을 때만, 한 번만). 회수 방식이 MANUAL이면 자동 기록하지 않는다.
    const earn = await tx.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId: ctx.sellerId, idempotencyKey: `earn:${orderId}` } } });
    const policy = earn ? await tx.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { revokeMode: true } }) : null;
    const rewardRevoke: RewardRevokeOutcome = !earn ? "none" : policy?.revokeMode === "MANUAL" ? "manual_review" : "revoked";
    if (earn && rewardRevoke === "revoked") {
      await tx.rewardLedger.create({
        data: {
          sellerId: ctx.sellerId,
          buyerMemberId: earn.buyerMemberId,
          orderId,
          type: "REVOKE",
          amount: -earn.amount,
          status: "PENDING",
          testMode: earn.testMode,
          idempotencyKey: `revoke:${orderId}`,
          createdAt: now,
        },
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
        ...(order.shipment ? { shipmentStatus: order.shipment.status } : {}),
      },
    });
    return { orderId, restockedItemIds, cancelledQueueItemIds, openedItemCount, rewardRevoke };
  });
}

