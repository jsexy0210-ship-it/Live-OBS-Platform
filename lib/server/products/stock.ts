import type { ActorType, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { getOrderPolicy } from "../orders/overdue";
import { INT4_MAX } from "../orders/shipping";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 재고 차감·복구 공통(카페24 방식, 대표님 결정 2026-10-03).
// - 상품마다 차감 시점을 고른다: ORDER(주문할 때) 또는 PAYMENT(결제 확인 때, 기본). 품목마다 뺀 시각(stockDeductedAt)을 남겨
//   결제 때는 아직 빼지 않은 품목만 뺀다.
// - 취소·반품 때 자동 복구(판매자 설정 restockOnCancel, 기본 켜짐): 결제 전 취소·미입금 자동 취소·발송 전 환불에서 뺀 품목만
//   되돌리고, 되돌린 시각(stockRestoredAt)을 남겨 두 번 되돌리지 않는다. 발송 후 환불은 되돌리지 않는다(호출하는 쪽에서 거름).
// - 차감은 언제나 조건부 UPDATE(stock >= 수량)라서 동시에 빼도 음수가 되지 않는다.

type Tx = Prisma.TransactionClient;
type Actor = { actorType: ActorType; actorId: string | null };

// 뺀 품목 중 아직 되돌리지 않은 것을 되돌린다. itemIds를 주면 그 품목만. 판매자가 자동 복구를 껐으면 아무것도 하지 않는다.
export async function restoreOrderStock(
  tx: Tx,
  input: { sellerId: string; orderId: string; reason: "CANCEL" | "REFUND"; now: Date; actor: Actor; itemIds?: string[] },
): Promise<string[]> {
  if (!(await getOrderPolicy(tx, input.sellerId)).restockOnCancel) return [];
  const items = await tx.orderItem.findMany({
    where: {
      sellerId: input.sellerId,
      orderId: input.orderId,
      stockDeductedAt: { not: null },
      stockRestoredAt: null,
      ...(input.itemIds ? { id: { in: input.itemIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  const restored: string[] = [];
  for (const item of items) {
    // 같은 품목을 동시에 되돌리려 해도 한 번만 되돌린다
    const claimed = await tx.orderItem.updateMany({ where: { id: item.id, stockRestoredAt: null }, data: { stockRestoredAt: input.now } });
    if (claimed.count !== 1) continue;
    await tx.productOption.update({ where: { id: item.optionId }, data: { stock: { increment: item.quantity } } });
    await tx.stockMovement.create({
      data: {
        sellerId: input.sellerId,
        optionId: item.optionId,
        delta: item.quantity,
        reason: input.reason,
        orderId: input.orderId,
        ...input.actor,
        createdAt: input.now,
      },
    });
    restored.push(item.id);
  }
  return restored;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StockAdjustFailure = "invalid_stock_adjust" | "insufficient_stock";

// 판매자 수동 증감(방송 이벤트 증정·서비스 등, PRODUCT_MANAGE). delta는 0이 아닌 정수, 사유 필수(최대 100자).
// 조건부 UPDATE(stock + delta >= 0, 정수 범위 안)라서 결제 차감과 겹쳐도 음수가 되거나 차감이 사라지지 않는다.
export async function adjustStock(
  db: PrismaClient,
  ctx: TenantContext,
  productId: string,
  optionId: string,
  raw: unknown,
): Promise<{ ok: true; value: { optionId: string; stock: number } } | { ok: false; reason: StockAdjustFailure }> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!UUID.test(productId) || !UUID.test(optionId)) throw notFound();
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const delta = b.delta;
  const reason = cleanText(b.reason, 100, "name");
  if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > INT4_MAX || !reason) {
    return { ok: false, reason: "invalid_stock_adjust" };
  }
  return db.$transaction(async (tx) => {
    const option = await tx.productOption.findFirst({
      where: { id: optionId, productId, sellerId: ctx.sellerId, deletedAt: null, product: { deletedAt: null } },
      select: { id: true, stock: true },
    });
    if (!option) throw notFound();
    const moved = await tx.productOption.updateMany({
      where: { id: optionId, sellerId: ctx.sellerId, stock: delta < 0 ? { gte: -delta } : { lte: INT4_MAX - delta } },
      data: { stock: { increment: delta } },
    });
    if (moved.count !== 1) return { ok: false as const, reason: "insufficient_stock" as const };
    const now = await dbNow(tx);
    await tx.stockMovement.create({
      data: { sellerId: ctx.sellerId, optionId, delta, reason: "MANUAL", note: reason, actorType: ctx.actorType, actorId: ctx.actorId, createdAt: now },
    });
    const after = await tx.productOption.findUniqueOrThrow({ where: { id: optionId }, select: { stock: true } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product_option.stock_adjust",
      targetType: "ProductOption",
      targetId: optionId,
      reason,
      after: { delta, stock: after.stock },
    });
    return { ok: true as const, value: { optionId, stock: after.stock } };
  });
}
