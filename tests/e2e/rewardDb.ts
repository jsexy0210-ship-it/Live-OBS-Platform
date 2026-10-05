import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 적립금 쓴 주문 e2e 준비(폐기용 테스트 DB). 쇼핑몰의 적립금 사용을 켜고 구매자에게 잔액을 넣는다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function allowRewardUseInDb(slug: string, loginId: string, balance: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.rewardPolicy.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, livePayoutEnabled: true }, update: { livePayoutEnabled: true } });
    await db.rewardBalance.upsert({
      where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } },
      create: { sellerId: seller.id, buyerMemberId: buyer.id, balance },
      update: { balance },
    });
  } finally {
    await db.$disconnect();
  }
}

export async function rewardBalanceInDb(slug: string, loginId: string): Promise<number> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    return (await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } } }))?.balance ?? 0;
  } finally {
    await db.$disconnect();
  }
}

export async function liveVersionInDb(slug: string): Promise<number> {
  const db = open();
  try {
    return (await db.seller.findUniqueOrThrow({ where: { slug }, select: { liveVersion: true } })).liveVersion;
  } finally {
    await db.$disconnect();
  }
}

// 이 시험이 만든 주문과 딸린 행(결제·주문대기·재고 이동·적립금 원장 포함)을 지운다. 환불까지 간 주문도 지울 수 있다.
export async function deleteOrderInDb(orderId: string) {
  const db = open();
  try {
    const where = { orderId };
    await db.$transaction([
      db.paymentCancel.deleteMany({ where: { payment: { orderId } } }),
      db.orderRefund.deleteMany({ where }),
      db.payment.deleteMany({ where }),
      db.queueItemStatusHistory.deleteMany({ where: { queueItem: { orderId } } }),
      db.hitCard.deleteMany({ where: { queueItem: { orderId } } }),
      db.queueItem.deleteMany({ where }),
      db.stockMovement.deleteMany({ where }),
      db.couponRedemption.deleteMany({ where }),
      db.orderStatusHistory.deleteMany({ where }),
      db.rewardLedger.deleteMany({ where }),
      db.orderConsent.deleteMany({ where }),
      db.orderShippingAddress.deleteMany({ where }),
      db.shipment.deleteMany({ where }),
      db.orderNotification.deleteMany({ where }),
      db.orderItem.deleteMany({ where }),
      db.order.deleteMany({ where: { id: orderId } }),
    ]);
  } finally {
    await db.$disconnect();
  }
}
