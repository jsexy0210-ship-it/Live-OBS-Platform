-- 유튜브 연동 PR 2(2026-10-05 MASTER 승인): 채팅 수집(방송별 켜기, 표시 이름·본문 앞 200자, 30일 보관). 규칙은 lib/server/youtube/chat.ts.
-- AlterTable
ALTER TABLE "YoutubeLiveLink" ADD COLUMN     "chatEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chatIntervalMs" INTEGER,
ADD COLUMN     "chatNextPollAt" TIMESTAMPTZ(3),
ADD COLUMN     "chatPageToken" TEXT;

-- CreateTable
CREATE TABLE "YoutubeChatMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "liveLinkId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "authorChannelId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YoutubeChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeChatMessage_messageId_key" ON "YoutubeChatMessage"("messageId");

-- CreateIndex
CREATE INDEX "YoutubeChatMessage_sellerId_liveLinkId_publishedAt_idx" ON "YoutubeChatMessage"("sellerId", "liveLinkId", "publishedAt");

-- CreateIndex
CREATE INDEX "YoutubeChatMessage_createdAt_idx" ON "YoutubeChatMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeLiveLink_sellerId_id_key" ON "YoutubeLiveLink"("sellerId", "id");

-- AddForeignKey
ALTER TABLE "YoutubeChatMessage" ADD CONSTRAINT "YoutubeChatMessage_sellerId_liveLinkId_fkey" FOREIGN KEY ("sellerId", "liveLinkId") REFERENCES "YoutubeLiveLink"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 본문은 앞 200자만, 표시 이름은 100자까지
ALTER TABLE "YoutubeChatMessage" ADD CONSTRAINT "YoutubeChatMessage_text_check" CHECK (char_length("text") <= 200 AND char_length("authorName") <= 100);
