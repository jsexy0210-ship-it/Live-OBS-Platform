import type { OrderStatus, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { canViewCustomerPii, requireSellerRead, type TenantContext } from "../tenant/context";

// 판매자 범위 조회의 기준 예시. where에는 항상 ctx.sellerId가 들어가고, 다른 판매자 주문은 없음(404)으로 처리한다.
// 구매자 이름·연락처(·주소)는 CUSTOMER_PII_VIEW가 있을 때만 응답에 넣고, 넣었으면 열람 기록을 남긴다
// (화면에서 가리는 것으로는 부족하다, 대표님 결정 2026-10-02).
export async function getOrder(db: PrismaClient, ctx: TenantContext, orderId: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const order = await db.order.findFirst({
    where: { id: orderId, sellerId: ctx.sellerId },
    include: {
      items: true,
      shipment: { select: { courier: true, trackingNumber: true, status: true, shippedAt: true, deliveredAt: true } },
      shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true, isRemote: true } },
      buyerMember: { select: { id: true, broadcastNickname: true, name: true, phone: true } },
    },
  });
  if (!order) throw notFound();

  const { buyerMember, shippingAddress, ...rest } = order;
  if (!canViewCustomerPii(ctx)) {
    // 배송지도 개인정보라 도서산간 여부(배송비 근거)만 남긴다
    return {
      ...rest,
      shippingAddress: shippingAddress ? { isRemote: shippingAddress.isRemote } : null,
      buyer: { id: buyerMember.id, broadcastNickname: buyerMember.broadcastNickname },
    };
  }
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "customer.pii.view",
    targetType: "Order",
    targetId: order.id,
  });
  return { ...rest, shippingAddress, buyer: buyerMember };
}

export async function listOrders(
  db: PrismaClient,
  ctx: TenantContext,
  opts: { status?: OrderStatus; take?: number } = {},
) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  return db.order.findMany({
    where: { sellerId: ctx.sellerId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 50, 200),
  });
}
