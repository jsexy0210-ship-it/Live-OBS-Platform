import { Prisma, type PaymentMethod, type PrismaClient, type QueueItem } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notifySellerChanged } from "../realtime/notify";
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
  requireSellerPermission(ctx, "broadcast.operate");
  const now = opts.now ?? new Date();
  if (action === "timer" && !isValidTimer(opts.timerSeconds)) return { ok: false, reason: "invalid_timer" };

  return run(
    db,
    ctx.sellerId,
    async (tx) => {
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
export async function reorderWaiting(
  db: PrismaClient,
  ctx: TenantContext,
  input: { broadcastSessionId: string | null; orderedIds: string[] },
): Promise<QueueResult<number>> {
  requireSellerPermission(ctx, "broadcast.operate");
  return run(db, ctx.sellerId, async (tx) => {
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
  requireSellerPermission(ctx, "broadcast.operate");
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
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
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
  requireSellerPermission(ctx, "broadcast.operate");
  const now = input.now ?? new Date();
  return run(db, ctx.sellerId, async (tx) => {
    const live = await tx.broadcastSession.findFirst({ where: { sellerId: ctx.sellerId, status: "LIVE" } });
    if (!live) throw new Rejected("not_live");
    if (await tx.queueItem.count({ where: { sellerId: ctx.sellerId, broadcastSessionId: live.id, status: "OPENING" } })) {
      throw new Rejected("opening_in_progress");
    }
    const carried = await tx.queueItem.updateMany({
      where: { sellerId: ctx.sellerId, broadcastSessionId: live.id, status: "WAITING" },
      data: { broadcastSessionId: null, version: { increment: 1 } },
    });
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
      await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: now, paymentMethod: input.paymentMethod } });
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
      await writeAudit(tx, { ...system, sellerId, action: "order.paid", targetType: "Order", targetId: orderId });
      return { orderId, stockShortage: false, queueItemIds };
    });
  } catch (e) {
    if (!(e instanceof StockShortage)) throw e;
  }

  return run(db, sellerId, async (tx) => {
    await loadPendingOrder(tx, sellerId, orderId);
    await tx.order.update({
      where: { id: orderId },
      data: { status: "PAID", paidAt: now, paymentMethod: input.paymentMethod, stockShortageAt: now },
    });
    await tx.orderStatusHistory.create({
      data: { sellerId, orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", ...system, reason: "stock_shortage", createdAt: now },
    });
    await writeAudit(tx, { ...system, sellerId, action: "order.stock_shortage", targetType: "Order", targetId: orderId });
    return { orderId, stockShortage: true, queueItemIds: [] };
  });
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
