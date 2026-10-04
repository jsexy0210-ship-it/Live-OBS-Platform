-- 유튜브 연동 PR 1(2026-10-05 MASTER 승인): 판매자 채널·방송 영상 연결, 하루 할당량 사용. 규칙은 lib/server/youtube/.
-- CreateEnum
CREATE TYPE "YoutubeLiveStatus" AS ENUM ('UPCOMING', 'LIVE', 'ENDED', 'UNLINKED');

-- CreateTable
CREATE TABLE "YoutubeChannelLink" (
    "sellerId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "uploadsPlaylistId" TEXT NOT NULL,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMPTZ(3),

    CONSTRAINT "YoutubeChannelLink_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "YoutubeLiveLink" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "YoutubeLiveStatus" NOT NULL DEFAULT 'UPCOMING',
    "liveChatId" TEXT,
    "scheduledStartAt" TIMESTAMPTZ(3),
    "actualStartAt" TIMESTAMPTZ(3),
    "actualEndAt" TIMESTAMPTZ(3),
    "broadcastSessionId" UUID,
    "autoStarted" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "YoutubeLiveLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YoutubeQuotaUsage" (
    "day" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "YoutubeQuotaUsage_pkey" PRIMARY KEY ("day","scope")
);

-- CreateIndex
CREATE INDEX "YoutubeLiveLink_status_idx" ON "YoutubeLiveLink"("status");

-- CreateIndex
CREATE INDEX "YoutubeLiveLink_sellerId_createdAt_idx" ON "YoutubeLiveLink"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "YoutubeChannelLink" ADD CONSTRAINT "YoutubeChannelLink_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YoutubeLiveLink" ADD CONSTRAINT "YoutubeLiveLink_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YoutubeLiveLink" ADD CONSTRAINT "YoutubeLiveLink_sellerId_broadcastSessionId_fkey" FOREIGN KEY ("sellerId", "broadcastSessionId") REFERENCES "BroadcastSession"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 진행 중 연결(예정·진행)은 판매자당 1개
CREATE UNIQUE INDEX "YoutubeLiveLink_one_active_per_seller" ON "YoutubeLiveLink"("sellerId") WHERE "status" IN ('UPCOMING', 'LIVE');
ALTER TABLE "YoutubeQuotaUsage" ADD CONSTRAINT "YoutubeQuotaUsage_units_check" CHECK ("units" >= 0);
