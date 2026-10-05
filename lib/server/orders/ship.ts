import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { getShippingPolicy, isCourier, parseShippingPolicy, type ShippingPolicy } from "./shipping";

// 즉시 발송 처리(ORDER_SHIPPING). 결제가 끝난(PAID)·재고가 차감된·배송지가 있는 즉시 발송 주문만 택배사·송장을 넣어 배송 중으로 바꾼다.
// 배송 중에는 송장을 고쳐 다시 넣을 수 있고, 배송 완료 뒤에는 바꾸지 않는다. 주문 상태(PAID)는 그대로 둔다.

export type ShipFailure = "not_found" | "invalid_shipment" | "not_shippable";
export type ShipResult =
  // mode: 처음 발송(shipped) 또는 이미 배송 중이던 송장을 바꿈(updated, previous = 바꾸기 전 택배사·송장번호)
  | {
      ok: true;
      shipment: { courier: string; trackingNumber: string; status: string; shippedAt: Date };
      mode: "shipped" | "updated";
      previous: { courier: string; trackingNumber: string } | null;
    }
  | { ok: false; reason: ShipFailure };

export function parseTrackingNumber(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\s-]/g, "");
  return /^[0-9A-Za-z]{8,30}$/.test(t) ? t : null;
}

export async function shipOrder(
  db: PrismaClient,
  ctx: TenantContext,
  orderId: string,
  input: { courier: unknown; trackingNumber: unknown },
): Promise<ShipResult> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  const trackingNumber = parseTrackingNumber(input.trackingNumber);
  if (!isCourier(input.courier) || !trackingNumber) return { ok: false, reason: "invalid_shipment" };
  const courier = input.courier;

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string; fulfillmentType: string; stockShortageAt: Date | null }[]>`
      SELECT "id", "status"::text AS "status", "fulfillmentType"::text AS "fulfillmentType", "stockShortageAt"
      FROM "Order" WHERE "id" = ${orderId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    const order = rows[0];
    if (!order) return { ok: false as const, reason: "not_found" as const };
    // 재고 부족으로 차감되지 않은 주문, 배송지가 없는 주문은 보낼 물건·주소가 없으니 발송하지 않는다
    if (order.status !== "PAID" || order.fulfillmentType !== "IMMEDIATE" || order.stockShortageAt) return { ok: false as const, reason: "not_shippable" as const };
    if (!(await tx.orderShippingAddress.findUnique({ where: { orderId }, select: { id: true } }))) return { ok: false as const, reason: "not_shippable" as const };
    const before = await tx.shipment.findUnique({ where: { orderId } });
    if (before?.status === "DELIVERED") return { ok: false as const, reason: "not_shippable" as const };

    const now = await dbNow(tx);
    const shipment = await tx.shipment.upsert({
      where: { orderId },
      create: { sellerId: ctx.sellerId, orderId, courier, trackingNumber, status: "IN_TRANSIT", shippedAt: now },
      update: { courier, trackingNumber, status: "IN_TRANSIT" },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: before ? "order.shipment.update" : "order.ship",
      targetType: "Order",
      targetId: orderId,
      before: before ? { courier: before.courier, trackingNumber: before.trackingNumber } : undefined,
      after: { courier, trackingNumber },
    });
    return {
      ok: true as const,
      shipment: { courier: shipment.courier, trackingNumber: shipment.trackingNumber, status: shipment.status, shippedAt: shipment.shippedAt },
      mode: before?.status === "IN_TRANSIT" ? ("updated" as const) : ("shipped" as const),
      previous: before?.status === "IN_TRANSIT" ? { courier: before.courier, trackingNumber: before.trackingNumber } : null,
    };
  });
}

// 판매자 배송비 설정(SHOP_SETTINGS). 설정이 없으면 기본값을 돌려준다.
export async function readShippingPolicy(db: PrismaClient, ctx: TenantContext): Promise<ShippingPolicy> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  return getShippingPolicy(db, ctx.sellerId);
}

export async function updateShippingPolicy(
  db: PrismaClient,
  ctx: TenantContext,
  raw: unknown,
): Promise<{ ok: true; policy: ShippingPolicy } | { ok: false; reason: "invalid_shipping_policy" }> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  return db.$transaction(async (tx) => {
    const before = await getShippingPolicy(tx, ctx.sellerId);
    const policy = parseShippingPolicy(raw, before);
    if (!policy) return { ok: false as const, reason: "invalid_shipping_policy" as const };
    await tx.sellerShippingPolicy.upsert({
      where: { sellerId: ctx.sellerId },
      create: { sellerId: ctx.sellerId, ...policy },
      update: policy,
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shipping_policy.update",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before,
      after: policy,
    });
    return { ok: true as const, policy };
  });
}
