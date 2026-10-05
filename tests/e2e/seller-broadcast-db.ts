import { PrismaClient } from "@prisma/client";
import { notifySellerChanged } from "../../lib/server/realtime/notify";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// SA-001 방송 대시보드 e2e 준비(폐기용 테스트 DB, 이름이 _test로 끝남). 데모 시드에는 대기 주문이 없어 여기서 만든다.
// 데모 쇼핑몰의 진행 중 방송을 끝내고, 남은 대기·개봉 중 주문을 취소한 뒤, 「bc-e2e-1~3」 대기 주문 3건을 방송 전 대기로 둔다.
// 실행마다 같은 3건을 다시 대기로 되돌려 쓴다(주문 품목당 주문대기 1건이라 새로 만들면 시드 품목이 줄어든다).
export const NICKS = ["bc-e2e-1", "bc-e2e-2", "bc-e2e-3"] as const;

const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetBroadcastQueue(slug = "demo-shop") {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const sellerId = seller.id;
    const now = new Date();
    await db.broadcastSession.updateMany({ where: { sellerId, status: "LIVE" }, data: { status: "ENDED", endedAt: now } });
    let mine = await db.queueItem.findMany({ where: { sellerId, nicknameSnapshot: { in: [...NICKS] } }, select: { id: true, nicknameSnapshot: true } });
    const missing = NICKS.filter((n) => !mine.some((m) => m.nicknameSnapshot === n));
    if (missing.length) {
      const free = await db.orderItem.findMany({
        where: { sellerId, queueItems: { none: {} }, order: { status: "PAID" } },
        select: { id: true, orderId: true, quantity: true, productNameSnapshot: true, optionNameSnapshot: true },
        take: missing.length,
      });
      if (free.length < missing.length) throw new Error("대기 주문을 만들 결제 완료 주문 품목이 모자랍니다. 테스트 DB를 새로 만들어 주십시오");
      for (const [i, f] of free.entries()) {
        await db.queueItem.create({
          data: {
            sellerId,
            orderId: f.orderId,
            orderItemId: f.id,
            position: 0,
            receivedAt: now,
            nicknameSnapshot: missing[i],
            productLabel: `${f.productNameSnapshot} ${f.optionNameSnapshot}`,
            quantity: f.quantity,
          },
        });
      }
      mine = await db.queueItem.findMany({ where: { sellerId, nicknameSnapshot: { in: [...NICKS] } }, select: { id: true, nicknameSnapshot: true } });
    }
    const ids = mine.map((m) => m.id);
    await db.queueItem.updateMany({
      where: { sellerId, status: { in: ["WAITING", "OPENING"] }, id: { notIn: ids } },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: "e2e 준비", version: { increment: 1 } },
    });
    for (const [i, n] of NICKS.entries()) {
      await db.queueItem.update({
        where: { id: mine.find((m) => m.nicknameSnapshot === n)!.id },
        data: {
          status: "WAITING",
          broadcastSessionId: null,
          position: i + 1,
          receivedAt: new Date(now.getTime() + i * 1000),
          timerSeconds: 0,
          openingStartedAt: null,
          doneAt: null,
          cancelledAt: null,
          cancelReason: null,
          version: { increment: 1 },
        },
      });
    }
    await db.seller.update({ where: { id: sellerId }, data: { liveVersion: { increment: 1 } } });
  } finally {
    await db.$disconnect();
  }
}

export async function queueStatuses(slug = "demo-shop") {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const rows = await db.queueItem.findMany({
      where: { sellerId: seller.id, nicknameSnapshot: { in: [...NICKS] } },
      select: { nicknameSnapshot: true, status: true, cancelReason: true, timerSeconds: true, broadcastSessionId: true },
    });
    return Object.fromEntries(rows.map((r) => [r.nicknameSnapshot, r]));
  } finally {
    await db.$disconnect();
  }
}

// 끝나면 3건을 취소로 두고(다른 e2e의 환불 화면에 「개봉한 상품」으로 잡히지 않게), since 뒤에 시작한 방송을 지운다(통계 e2e의 방송 수가 바뀌지 않게)
export async function cleanupBroadcastQueue(since: Date, slug = "demo-shop") {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const now = new Date();
    await db.queueItem.updateMany({
      where: { sellerId: seller.id, nicknameSnapshot: { in: [...NICKS] } },
      data: { status: "CANCELLED", broadcastSessionId: null, cancelledAt: now, cancelReason: "e2e 정리", version: { increment: 1 } },
    });
    await db.broadcastSession.deleteMany({ where: { sellerId: seller.id, startedAt: { gte: since } } });
    await db.seller.update({ where: { id: seller.id }, data: { liveVersion: { increment: 1 } } });
  } finally {
    await db.$disconnect();
  }
}

// 다른 곳에서 바뀐 것처럼 실시간 version만 올리고 알린다(대시보드가 주문대기를 다시 읽게)
export async function bumpLiveVersion(slug = "demo-shop") {
  const db = open();
  try {
    const s = await db.seller.update({ where: { slug }, data: { liveVersion: { increment: 1 } }, select: { id: true, liveVersion: true } });
    await notifySellerChanged(db, s.id, s.liveVersion);
  } finally {
    await db.$disconnect();
  }
}

// e2e가 만든 HIT 카드(카드명이 「e2e-」로 시작)를 지운다. 카드가 방송을 가리키면 방송 정리가 막히므로 방송 정리 전에 부른다.
export async function purgeE2eHitCards(slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    await db.hitCard.deleteMany({ where: { sellerId, cardName: { startsWith: "e2e-" } } });
  } finally {
    await db.$disconnect();
  }
}

// 시험 주문은 방송 전에 만든 것이라 방송 시간 안에 들어온 주문으로 맞춘다(방송 이력·상세는 방송 시작~종료 안에 들어온 주문만 센다)
export async function moveQueueOrdersToNow(nicks: readonly string[], slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    for (const n of nicks) {
      const item = await db.queueItem.findFirstOrThrow({ where: { sellerId, nicknameSnapshot: n }, select: { orderId: true } });
      await db.order.update({ where: { id: item.orderId }, data: { createdAt: new Date(), broadcastNicknameSnapshot: n } });
    }
  } finally {
    await db.$disconnect();
  }
}
