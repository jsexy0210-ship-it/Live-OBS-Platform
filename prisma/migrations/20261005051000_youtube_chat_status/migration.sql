-- 유튜브 채팅 수집 상태(방송 대시보드 띠, 2026-10-05 MASTER 배정): 마지막 수집 시각·멈춘 이유. 규칙은 lib/server/youtube/chat.ts chatStateOf.
-- AlterTable
ALTER TABLE "YoutubeLiveLink" ADD COLUMN     "chatLastPolledAt" TIMESTAMPTZ(3),
ADD COLUMN     "chatStopReason" TEXT;

