-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('MAIL_TRANSACTIONAL', 'MAIL_BULK', 'SMS', 'LMS', 'ALIMTALK', 'IDENTITY_VERIFICATION', 'DELIVERY_TRACKING');

-- CreateEnum
CREATE TYPE "MessageLedgerType" AS ENUM ('CHARGE', 'GRANT', 'DEBIT', 'REFUND');

-- CreateEnum
CREATE TYPE "MessageLedgerStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "MailDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_BALANCE', 'SKIPPED_PLATFORM_LIMIT');

-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "mailMonthlyQuota" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "nextMailQuota" INTEGER,
ADD COLUMN     "nextMailQuotaAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "SellerMessageBalance" (
    "sellerId" UUID NOT NULL,
    "paidBalance" INTEGER NOT NULL DEFAULT 0,
    "freeBalance" INTEGER NOT NULL DEFAULT 0,
    "lowBalanceThreshold" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerMessageBalance_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "SellerMessageLedger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "type" "MessageLedgerType" NOT NULL,
    "status" "MessageLedgerStatus" NOT NULL,
    "channel" "MessageChannel",
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER,
    "paidAmount" INTEGER NOT NULL,
    "freeAmount" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SellerMessageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerMessageFeeConsent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "consentedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerMessageFeeConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageChannelPrice" (
    "channel" "MessageChannel" NOT NULL,
    "unitPrice" INTEGER NOT NULL DEFAULT 0,
    "pendingUnitPrice" INTEGER,
    "pendingEffectiveAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MessageChannelPrice_pkey" PRIMARY KEY ("channel")
);

-- CreateTable
CREATE TABLE "PlatformMessageSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "chargingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "platformDailyLimit" INTEGER NOT NULL DEFAULT 100,
    "platformMonthlyLimit" INTEGER NOT NULL DEFAULT 3000,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlatformMessageSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID,
    "kind" TEXT NOT NULL,
    "bulk" BOOLEAN NOT NULL DEFAULT false,
    "refId" TEXT,
    "month" TEXT NOT NULL,
    "status" "MailDeliveryStatus" NOT NULL,
    "charged" BOOLEAN NOT NULL DEFAULT false,
    "ledgerId" UUID,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerMessageLedger_sellerId_createdAt_idx" ON "SellerMessageLedger"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SellerMessageFeeConsent_sellerId_version_key" ON "SellerMessageFeeConsent"("sellerId", "version");

-- CreateIndex
CREATE INDEX "MailDelivery_sellerId_month_status_idx" ON "MailDelivery"("sellerId", "month", "status");

-- CreateIndex
CREATE INDEX "MailDelivery_createdAt_status_idx" ON "MailDelivery"("createdAt", "status");

-- AddForeignKey
ALTER TABLE "SellerMessageBalance" ADD CONSTRAINT "SellerMessageBalance_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerMessageLedger" ADD CONSTRAINT "SellerMessageLedger_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerMessageFeeConsent" ADD CONSTRAINT "SellerMessageFeeConsent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "SellerMessageLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 잔액은 음수가 될 수 없다(서식 2-1). 동시에 차감해도 이 제약이 마지막으로 막는다.
ALTER TABLE "SellerMessageBalance" ADD CONSTRAINT "SellerMessageBalance_nonneg" CHECK ("paidBalance" >= 0 AND "freeBalance" >= 0 AND "lowBalanceThreshold" >= 0);
-- 원장 부호: 충전 +유료, 무상 지급 +무상, 차감 0 이하, 환불 −유료
ALTER TABLE "SellerMessageLedger" ADD CONSTRAINT "SellerMessageLedger_sign" CHECK (
  ("type" = 'CHARGE' AND "paidAmount" > 0 AND "freeAmount" = 0)
  OR ("type" = 'GRANT' AND "paidAmount" = 0 AND "freeAmount" > 0)
  OR ("type" = 'DEBIT' AND "paidAmount" <= 0 AND "freeAmount" <= 0 AND "channel" IS NOT NULL)
  OR ("type" = 'REFUND' AND "paidAmount" < 0 AND "freeAmount" = 0)
);
-- 같은 요청은 한 번만(되돌린 차감은 빼고 센다: 알림톡 실패 뒤 같은 키로 문자를 잡을 수 있게, 서식 3-2·3-3)
CREATE UNIQUE INDEX "SellerMessageLedger_sellerId_idempotencyKey_live_key" ON "SellerMessageLedger"("sellerId", "idempotencyKey") WHERE "status" <> 'REVERSED';
ALTER TABLE "MessageChannelPrice" ADD CONSTRAINT "MessageChannelPrice_nonneg" CHECK ("unitPrice" >= 0 AND ("pendingUnitPrice" IS NULL OR "pendingUnitPrice" >= 0));
ALTER TABLE "PlatformMessageSetting" ADD CONSTRAINT "PlatformMessageSetting_single_row" CHECK ("id" = 1);
ALTER TABLE "PlatformMessageSetting" ADD CONSTRAINT "PlatformMessageSetting_nonneg" CHECK ("platformDailyLimit" >= 0 AND "platformMonthlyLimit" >= 0);
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_mailQuota_nonneg" CHECK ("mailMonthlyQuota" >= 0 AND ("nextMailQuota" IS NULL OR "nextMailQuota" >= 0));
-- 원장 행위자는 시스템·파트너스 직원·관리자만(구매자 회원 id가 들어가지 않게, buyers/memberData.ts)
ALTER TABLE "SellerMessageLedger" ADD CONSTRAINT "SellerMessageLedger_actor_not_buyer" CHECK ("actorType" <> 'BUYER');
