import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 교환·반품 e2e 준비·정리(폐기용 테스트 DB, 이름이 _test로 끝남). 데모 구매자에게 배송 완료된(구매 확정 전) 주문을 만들고, 끝나면 신청과 그 주문을 지운다.
// 이 시험이 만든 주문은 주문 번호 920000번대라 다른 시험의 데모 주문과 섞이지 않는다.
const ORDER_NO_BASE = 920000;
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

// rewardUsed: 이 주문에서 쓴 적립금(결제 금액에서 뺀다). 환불·반품 미리보기의 적립금 반환 줄을 확인할 때 쓴다.
export async function deliveredOrderInDb(slug: string, loginId: string, rewardUsed = 0): Promise<{ orderId: string; orderNo: number }> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, product: { deletedAt: null } }, include: { product: true } });
    const last = await db.order.aggregate({ where: { sellerId: seller.id, orderNo: { gte: ORDER_NO_BASE } }, _max: { orderNo: true } });
    const order = await db.order.create({
      data: { sellerId: seller.id, orderNo: (last._max.orderNo ?? ORDER_NO_BASE) + 1, buyerMemberId: buyer.id, status: "PAID", broadcastNicknameSnapshot: buyer.broadcastNickname, totalAmount: option.product.price - rewardUsed, rewardUsedAmount: rewardUsed, paidAt: new Date() },
    });
    await db.orderItem.create({
      data: { sellerId: seller.id, orderId: order.id, productId: option.productId, optionId: option.id, productNameSnapshot: option.product.name, optionNameSnapshot: option.name, unitPrice: option.product.price, quantity: 1 },
    });
    await db.shipment.create({ data: { sellerId: seller.id, orderId: order.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(Date.now() - 2 * 86_400_000), deliveredAt: new Date(Date.now() - 3_600_000) } });
    return { orderId: order.id, orderNo: order.orderNo };
  } finally {
    await db.$disconnect();
  }
}

export async function orderStatusInDb(orderId: string): Promise<string> {
  const db = open();
  try {
    return (await db.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  } finally {
    await db.$disconnect();
  }
}

export async function clearReturnsInDb(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    const orders = await db.order.findMany({ where: { sellerId: seller.id, orderNo: { gte: ORDER_NO_BASE } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await db.returnRequestImage.deleteMany({ where: { sellerId: seller.id } });
    await db.returnRequestItem.deleteMany({ where: { sellerId: seller.id } });
    await db.returnRequest.deleteMany({ where: { sellerId: seller.id } });
    await db.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await db.stockMovement.deleteMany({ where: { orderId: { in: ids } } });
    await db.rewardLedger.deleteMany({ where: { sellerId: seller.id, orderId: { in: ids } } });
    await db.shipment.deleteMany({ where: { orderId: { in: ids } } });
    await db.orderRefund.deleteMany({ where: { orderId: { in: ids } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
}
