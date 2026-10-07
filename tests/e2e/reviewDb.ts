import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 리뷰 e2e 준비·정리(폐기용 테스트 DB, 이름이 _test로 끝남). 데모 구매자에게 배송 완료된 주문 상품을 하나 만들고, 끝나면 리뷰와 그 주문을 지운다.
// 이 시험이 만든 주문은 주문 번호 900000번대라 다른 시험의 데모 주문과 섞이지 않는다.
const ORDER_NO_BASE = 900000;
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function deliveredItemInDb(slug: string, loginId: string): Promise<string> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, product: { deletedAt: null } }, include: { product: true } });
    const last = await db.order.aggregate({ where: { sellerId: seller.id, orderNo: { gte: ORDER_NO_BASE } }, _max: { orderNo: true } });
    const order = await db.order.create({
      data: { sellerId: seller.id, orderNo: (last._max.orderNo ?? ORDER_NO_BASE) + 1, buyerMemberId: buyer.id, status: "PAID", broadcastNicknameSnapshot: buyer.broadcastNickname, totalAmount: option.product.price, paidAt: new Date() },
    });
    const item = await db.orderItem.create({
      data: { sellerId: seller.id, orderId: order.id, productId: option.productId, optionId: option.id, productNameSnapshot: option.product.name, optionNameSnapshot: option.name, unitPrice: option.product.price, quantity: 1 },
    });
    await db.shipment.create({ data: { sellerId: seller.id, orderId: order.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(Date.now() - 2 * 86_400_000), deliveredAt: new Date(Date.now() - 86_400_000) } });
    return item.id;
  } finally {
    await db.$disconnect();
  }
}

export async function reviewInDb(itemId: string): Promise<void> {
  const db = open();
  try {
    const item = await db.orderItem.findUniqueOrThrow({ where: { id: itemId }, include: { order: true } });
    const buyer = await db.buyerMember.findUniqueOrThrow({ where: { id: item.order.buyerMemberId } });
    await db.productReview.create({
      data: {
        sellerId: item.sellerId,
        orderId: item.orderId,
        orderItemId: item.id,
        productId: item.productId,
        buyerMemberId: buyer.id,
        authorNickname: buyer.broadcastNickname,
        rating: 5,
        body: "브레이크 때 뽑힌 카드 상태가 정말 좋았어요. 포장도 꼼꼼하고 배송도 빨랐어요.",
      },
    });
  } finally {
    await db.$disconnect();
  }
}

export async function clearReviewsInDb(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    await db.productReview.deleteMany({ where: { sellerId: seller.id } });
    await db.productReviewImage.deleteMany({ where: { sellerId: seller.id } });
    await db.productReviewPolicy.deleteMany({ where: { sellerId: seller.id } });
    const orders = await db.order.findMany({ where: { sellerId: seller.id, orderNo: { gte: ORDER_NO_BASE } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await db.rewardLedger.deleteMany({ where: { sellerId: seller.id, orderId: { in: ids } } });
    await db.shipment.deleteMany({ where: { orderId: { in: ids } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
}
