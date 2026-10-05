-- 유튜브 채팅 중복 기준을 판매자별로(검수 후속, 2026-10-05): 같은 방송을 두 판매자가 연결해도 각자 저장한다.
-- DropIndex
DROP INDEX "YoutubeChatMessage_messageId_key";

-- CreateIndex
CREATE UNIQUE INDEX "YoutubeChatMessage_sellerId_messageId_key" ON "YoutubeChatMessage"("sellerId", "messageId");

