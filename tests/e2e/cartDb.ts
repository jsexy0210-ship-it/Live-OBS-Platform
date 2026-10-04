import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 장바구니 e2e 준비·정리(폐기용 테스트 DB). 데모 구매자의 장바구니를 비우고 상품 이름으로 고른 첫 옵션을 담는다.
// 품절 줄은 API가 담기를 막으므로 DB에 바로 넣는다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetCartInDb(slug: string, loginId: string, lines: { productName: string; quantity: number }[]) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.cartItem.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    for (const l of lines) {
      const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, product: { name: l.productName, deletedAt: null } }, orderBy: { createdAt: "asc" } });
      await db.cartItem.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, optionId: option.id, quantity: l.quantity } });
    }
  } finally {
    await db.$disconnect();
  }
}

// 주문서 e2e가 만든 주문 정리: 데모 구매자가 since 이후에 만든 주문과 딸린 행을 지운다(재고 이동·알림 포함).
export async function deleteBuyerOrdersSince(slug: string, loginId: string, since: Date) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    const orders = await db.order.findMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id, createdAt: { gte: since } }, select: { id: true } });
    const orderId = { in: orders.map((o) => o.id) };
    await db.$transaction([
      db.stockMovement.deleteMany({ where: { orderId } }),
      db.couponRedemption.deleteMany({ where: { orderId } }),
      db.orderStatusHistory.deleteMany({ where: { orderId } }),
      db.queueItem.deleteMany({ where: { orderId } }),
      db.rewardLedger.deleteMany({ where: { orderId } }),
      db.orderConsent.deleteMany({ where: { orderId } }),
      db.orderShippingAddress.deleteMany({ where: { orderId } }),
      db.shipment.deleteMany({ where: { orderId } }),
      db.orderNotification.deleteMany({ where: { orderId } }),
      db.orderItem.deleteMany({ where: { orderId } }),
      db.order.deleteMany({ where: { id: orderId } }),
    ]);
  } finally {
    await db.$disconnect();
  }
}

// 찜 e2e 준비·정리: 데모 구매자의 찜을 비우고 상품 이름으로 고른 상품을 넣는다(품절 상품도 DB에 바로 넣는다).
export async function resetWishlistInDb(slug: string, loginId: string, productNames: string[]) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.wishItem.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    for (const name of productNames) {
      const product = await db.product.findFirstOrThrow({ where: { sellerId: seller.id, name, deletedAt: null } });
      await db.wishItem.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, productId: product.id } });
    }
  } finally {
    await db.$disconnect();
  }
}

// 상품 상세 e2e: 옵션 재고를 바꾸고 이전 값을 돌려준다(옵션 일부 품절 시험용)
export async function setOptionStockInDb(slug: string, productName: string, optionName: string, stock: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, name: optionName, product: { name: productName, deletedAt: null } } });
    await db.productOption.update({ where: { id: option.id }, data: { stock } });
    return option.stock;
  } finally {
    await db.$disconnect();
  }
}
