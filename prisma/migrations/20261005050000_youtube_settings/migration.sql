-- 유튜브 파트너스 설정·월 수집 현황(SA-057, 2026-10-05 MASTER 배정): 채팅 수집 기본값, 월 수집 건수. 규칙은 lib/server/youtube/settings.ts.
-- CreateTable
CREATE TABLE "YoutubeSellerSetting" (
    "sellerId" UUID NOT NULL,
    "chatDefaultEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "YoutubeSellerSetting_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "YoutubeChatMonthly" (
    "sellerId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "YoutubeChatMonthly_pkey" PRIMARY KEY ("sellerId","month")
);


ALTER TABLE "YoutubeChatMonthly" ADD CONSTRAINT "YoutubeChatMonthly_messages_check" CHECK ("messages" >= 0);
