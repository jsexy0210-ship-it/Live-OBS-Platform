import { PrismaClient } from "@prisma/client";
import { notifySellerChanged } from "../../lib/server/realtime/notify";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 외부 쇼핑몰 주문 e2e 준비(폐기용 테스트 DB). 외부 주문 1건을 방송 전 대기로 넣고, 진행 중 방송 안으로 옮기고 HIT 카드를 붙인다.
export const EXT_NICK = "bc-ext-1";
export const EXT_PRODUCT = "외부 테스트 상품";
export const EXT_CARD_PREFIX = "e2e-ext-카드";
const SHOP_KEY = "e2e-ext-shop";

const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function seedExternalQueue(slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const conn =
      (await db.externalShopConnection.findFirst({ where: { sellerId, shopKey: SHOP_KEY } })) ?? (await db.externalShopConnection.create({ data: { sellerId, shopKey: SHOP_KEY } }));
    const order = await db.externalOrder.upsert({
      where: { connectionId_externalOrderId: { connectionId: conn.id, externalOrderId: "e2e-ext-1" } },
      update: { cancelledAt: null, receivedAt: new Date() },
      create: { sellerId, connectionId: conn.id, externalOrderId: "e2e-ext-1", buyerLabel: EXT_NICK },
    });
    const existing = await db.queueItem.findFirst({ where: { sellerId, externalOrderId: order.id, externalLineNo: 1 }, select: { id: true } });
    const data = { status: "WAITING" as const, broadcastSessionId: null, position: 4, receivedAt: new Date(), timerSeconds: 0, openingStartedAt: null, doneAt: null, cancelledAt: null, cancelReason: null };
    if (existing) await db.queueItem.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
    else await db.queueItem.create({ data: { sellerId, externalOrderId: order.id, externalLineNo: 1, nicknameSnapshot: EXT_NICK, productLabel: EXT_PRODUCT, quantity: 1, ...data } });
    const s = await db.seller.update({ where: { id: sellerId }, data: { liveVersion: { increment: 1 } }, select: { liveVersion: true } });
    await notifySellerChanged(db, sellerId, s.liveVersion);
  } finally {
    await db.$disconnect();
  }
}

// 진행 중 방송 안으로 외부 주문을 옮기고 그 주문에 HIT 카드를 만든다(방송 상세·HIT 이력에서 출처 표시를 보기 위해)
export async function putExternalInLiveBroadcast(cardName: string, slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const session = await db.broadcastSession.findFirstOrThrow({ where: { sellerId, status: "LIVE" }, select: { id: true } });
    const item = await db.queueItem.findFirstOrThrow({ where: { sellerId, nicknameSnapshot: EXT_NICK }, select: { id: true, externalOrderId: true } });
    await db.externalOrder.update({ where: { id: item.externalOrderId! }, data: { receivedAt: new Date() } });
    await db.hitCard.create({ data: { sellerId, broadcastSessionId: session.id, queueItemId: item.id, nicknameSnapshot: EXT_NICK, cardName } });
  } finally {
    await db.$disconnect();
  }
}

export async function cleanupExternalQueue(slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    await db.hitCard.deleteMany({ where: { sellerId, cardName: { startsWith: EXT_CARD_PREFIX } } });
    await db.queueItem.updateMany({ where: { sellerId, nicknameSnapshot: EXT_NICK }, data: { status: "CANCELLED", broadcastSessionId: null, cancelledAt: new Date(), cancelReason: "e2e 정리", version: { increment: 1 } } });
    await db.seller.update({ where: { id: sellerId }, data: { liveVersion: { increment: 1 } } });
  } finally {
    await db.$disconnect();
  }
}
