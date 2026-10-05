import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// LIVE 전면 e2e: 폐기용 테스트 DB에서 진행 중 방송을 만들고(주문 하나를 그 방송의 대기열에 올려 「방송 중 상품」으로 만든다), 끝에 지운다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function startLiveInDb(slug: string, orderId?: string): Promise<string> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const session = await db.broadcastSession.create({ data: { sellerId: seller.id, status: "LIVE", title: "e2e 라이브 방송" } });
    if (orderId) {
      const item = await db.orderItem.findFirstOrThrow({ where: { sellerId: seller.id, orderId }, select: { id: true, productNameSnapshot: true, quantity: true } });
      await db.queueItem.create({
        data: { sellerId: seller.id, orderId, orderItemId: item.id, broadcastSessionId: session.id, position: 1, receivedAt: new Date(), nicknameSnapshot: "e2e", productLabel: item.productNameSnapshot, quantity: item.quantity },
      });
    }
    return session.id;
  } finally {
    await db.$disconnect();
  }
}

export async function endLiveInDb(sessionId: string) {
  const db = open();
  try {
    await db.queueItem.deleteMany({ where: { broadcastSessionId: sessionId } });
    await db.broadcastSession.deleteMany({ where: { id: sessionId } });
  } finally {
    await db.$disconnect();
  }
}
