import type { OrderStatus, PrismaClient } from "@prisma/client";
import { notFound } from "../authz/errors";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 판매자 범위 조회의 기준 예시. where에는 항상 ctx.sellerId가 들어가고, 다른 판매자 주문은 없음(404)으로 처리한다.
export async function getOrder(db: PrismaClient, ctx: TenantContext, orderId: string) {
  requireSellerPermission(ctx, "order.read");
  const order = await db.order.findFirst({
    where: { id: orderId, sellerId: ctx.sellerId },
    include: { items: true },
  });
  if (!order) throw notFound();
  return order;
}

export async function listOrders(
  db: PrismaClient,
  ctx: TenantContext,
  opts: { status?: OrderStatus; take?: number } = {},
) {
  requireSellerPermission(ctx, "order.read");
  return db.order.findMany({
    where: { sellerId: ctx.sellerId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 50, 200),
  });
}
