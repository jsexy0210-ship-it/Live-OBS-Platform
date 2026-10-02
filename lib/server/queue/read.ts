import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";

const ITEM_FIELDS = {
  id: true,
  status: true,
  position: true,
  receivedAt: true,
  nicknameSnapshot: true,
  gradeSnapshot: true,
  productLabel: true,
  quantity: true,
  timerSeconds: true,
  openingStartedAt: true,
  doneAt: true,
  version: true,
  broadcastSessionId: true,
} as const;

// 방송 대시보드 상태. version은 실시간 알림·15초 확인용(docs/ARCHITECTURE.md 6절).
export async function getQueueSnapshot(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const sellerId = ctx.sellerId;
  return db.$transaction(
    async (tx) => {
      const seller = await tx.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { liveVersion: true } });
      const live = await tx.broadcastSession.findFirst({
        where: { sellerId, status: "LIVE" },
        select: { id: true, title: true, startedAt: true },
      });
      const [opening, waiting, beforeBroadcast, recentDone] = await Promise.all([
        tx.queueItem.findFirst({ where: { sellerId, status: "OPENING" }, select: ITEM_FIELDS }),
        live
          ? tx.queueItem.findMany({
              where: { sellerId, broadcastSessionId: live.id, status: "WAITING" },
              orderBy: [{ position: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
              select: ITEM_FIELDS,
            })
          : Promise.resolve([]),
        tx.queueItem.findMany({
          where: { sellerId, broadcastSessionId: null, status: "WAITING" },
          orderBy: [{ position: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
          select: ITEM_FIELDS,
        }),
        tx.queueItem.findMany({
          where: { sellerId, status: "DONE" },
          orderBy: [{ doneAt: "desc" }, { id: "desc" }],
          take: 10,
          select: ITEM_FIELDS,
        }),
      ]);
      return { version: seller.liveVersion, broadcast: live, opening, waiting, beforeBroadcast, recentDone };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function getLiveVersion(db: PrismaClient, ctx: TenantContext): Promise<number> {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const s = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { liveVersion: true } });
  return s.liveVersion;
}
