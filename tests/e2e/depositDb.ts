import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 입금 확인 e2e 준비·정리(폐기용 테스트 DB, 이름이 _test로 끝남). 입금 기한이 지난 무통장 입금 대기 주문 3건을 만들고,
// 끝나면 그 주문과 입금 확인으로 줄어든 재고를 되돌린다. 주문 번호는 910000번대라 다른 시험의 데모 주문과 섞이지 않는다.
const ORDER_NO_BASE = 910000;
export const DEPOSIT_NICKNAMES = ["입금e2e-하나", "입금e2e-둘", "입금e2e-셋"] as const;
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

// 반환: 만든 주문 id 두 개와 되돌릴 재고(정리 때 쓴다)
export async function pendingDepositsInDb(slug: string): Promise<{ orderIds: string[]; optionId: string; stock: number }> {
  const db = open();
  try {
    await clearPendingDepositsInDb(slug);
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId: "demo-buyer1@example.com", deletedAt: null } });
    const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, stock: { gte: 20 }, product: { deletedAt: null, status: "ON_SALE" } }, include: { product: true } });
    const orderIds: string[] = [];
    for (const [i, nickname] of DEPOSIT_NICKNAMES.entries()) {
      const order = await db.order.create({
        data: {
          sellerId: seller.id,
          orderNo: ORDER_NO_BASE + i + 1,
          buyerMemberId: buyer.id,
          status: "PENDING_PAYMENT",
          paymentMethod: "BANK_TRANSFER",
          broadcastNicknameSnapshot: nickname,
          totalAmount: option.product.price + option.priceDelta,
          paymentDueAt: new Date(Date.UTC(2000, 0, 1, i, 0, 0)),
        },
      });
      await db.orderItem.create({
        data: { sellerId: seller.id, orderId: order.id, productId: option.productId, optionId: option.id, productNameSnapshot: option.product.name, optionNameSnapshot: option.name, unitPrice: option.product.price + option.priceDelta, quantity: 1 },
      });
      orderIds.push(order.id);
    }
    return { orderIds, optionId: option.id, stock: option.stock };
  } finally {
    await db.$disconnect();
  }
}

export async function clearPendingDepositsInDb(slug: string, restore?: { optionId: string; stock: number }) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    const orders = await db.order.findMany({ where: { sellerId: seller.id, orderNo: { gte: ORDER_NO_BASE } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await db.queueItem.deleteMany({ where: { orderItem: { orderId: { in: ids } } } });
    await db.stockMovement.deleteMany({ where: { orderId: { in: ids } } });
    await db.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
    await db.orderNotification.deleteMany({ where: { orderId: { in: ids } } });
    await db.rewardLedger.deleteMany({ where: { orderId: { in: ids } } });
    await db.payment.deleteMany({ where: { orderId: { in: ids } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await db.order.deleteMany({ where: { id: { in: ids } } });
    if (restore) await db.productOption.update({ where: { id: restore.optionId }, data: { stock: restore.stock } });
  } finally {
    await db.$disconnect();
  }
}

// 화면이 목록을 받은 뒤 다른 곳에서 바뀐 것처럼 판매자 liveVersion을 올린다(입금 확인이 409로 막히는지 보는 시험용)
export async function bumpLiveVersionInDb(slug: string) {
  const db = open();
  try {
    await db.seller.update({ where: { slug }, data: { liveVersion: { increment: 1 } } });
  } finally {
    await db.$disconnect();
  }
}
