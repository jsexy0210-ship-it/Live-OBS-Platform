-- 회원 대상 발송(발송 기록만, 실제 발송 채널 결정 전)
-- CreateEnum
CREATE TYPE "MemberMessageKind" AS ENUM ('AD', 'INFO');

-- CreateEnum
CREATE TYPE "MemberMessageChannel" AS ENUM ('ALIMTALK_SMS', 'ALIMTALK', 'MAIL');

-- CreateEnum
CREATE TYPE "MemberMessageTarget" AS ENUM ('ALL', 'GRADE', 'WISHED', 'BOUGHT_30D', 'NOT_BOUGHT_90D', 'PRODUCT_BOUGHT', 'PICKED');

-- CreateEnum
CREATE TYPE "MemberMessageStatus" AS ENUM ('SCHEDULED', 'RECORDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MemberMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "MemberMessageKind" NOT NULL,
    "channel" "MemberMessageChannel" NOT NULL,
    "body" TEXT NOT NULL,
    "renderedBody" TEXT NOT NULL,
    "targetType" "MemberMessageTarget" NOT NULL,
    "targetParams" JSONB NOT NULL DEFAULT '{}',
    "status" "MemberMessageStatus" NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3),
    "recordedAt" TIMESTAMPTZ(3),
    "estimatedCount" INTEGER NOT NULL,
    "recipientCount" INTEGER,
    "skippedDailyCap" INTEGER NOT NULL DEFAULT 0,
    "staffId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMessageRecipient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberMessageRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberMessage_sellerId_id_key" ON "MemberMessage"("sellerId", "id");

-- CreateIndex
CREATE INDEX "MemberMessage_sellerId_createdAt_idx" ON "MemberMessage"("sellerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MemberMessage_status_scheduledAt_idx" ON "MemberMessage"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMessageRecipient_messageId_buyerMemberId_key" ON "MemberMessageRecipient"("messageId", "buyerMemberId");

-- CreateIndex
CREATE INDEX "MemberMessageRecipient_sellerId_buyerMemberId_createdAt_idx" ON "MemberMessageRecipient"("sellerId", "buyerMemberId", "createdAt");

-- AddForeignKey
ALTER TABLE "MemberMessage" ADD CONSTRAINT "MemberMessage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberMessageRecipient" ADD CONSTRAINT "MemberMessageRecipient_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberMessageRecipient" ADD CONSTRAINT "MemberMessageRecipient_sellerId_messageId_fkey" FOREIGN KEY ("sellerId", "messageId") REFERENCES "MemberMessage"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberMessageRecipient" ADD CONSTRAINT "MemberMessageRecipient_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 상태에 맞는 칸: 예약은 예약 시각, 기록은 기록 시각·받는 사람 수
ALTER TABLE "MemberMessage" ADD CONSTRAINT "MemberMessage_status_fields" CHECK (
  ("status" = 'SCHEDULED' AND "scheduledAt" IS NOT NULL AND "recordedAt" IS NULL AND "recipientCount" IS NULL)
  OR ("status" = 'RECORDED' AND "recordedAt" IS NOT NULL AND "recipientCount" IS NOT NULL AND "recipientCount" >= 0)
  OR ("status" = 'CANCELLED' AND "recordedAt" IS NULL AND "recipientCount" IS NULL)
);
ALTER TABLE "MemberMessage" ADD CONSTRAINT "MemberMessage_counts" CHECK ("estimatedCount" >= 0 AND "skippedDailyCap" >= 0);
