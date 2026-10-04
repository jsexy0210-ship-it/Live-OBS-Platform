-- CreateEnum
CREATE TYPE "MailDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_QUOTA', 'SKIPPED_PLATFORM_LIMIT');

-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "mailMonthlyQuota" INTEGER NOT NULL DEFAULT 100;

-- CreateTable
CREATE TABLE "SellerMailPolicy" (
    "sellerId" UUID NOT NULL,
    "overageAllowed" BOOLEAN NOT NULL DEFAULT false,
    "overageMonthlyCap" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerMailPolicy_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "PlatformMailSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "overageUnitPrice" INTEGER NOT NULL DEFAULT 0,
    "platformDailyLimit" INTEGER NOT NULL DEFAULT 100,
    "platformMonthlyLimit" INTEGER NOT NULL DEFAULT 3000,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlatformMailSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID,
    "kind" TEXT NOT NULL,
    "refId" TEXT,
    "month" TEXT NOT NULL,
    "status" "MailDeliveryStatus" NOT NULL,
    "overage" BOOLEAN NOT NULL DEFAULT false,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailDelivery_sellerId_month_status_idx" ON "MailDelivery"("sellerId", "month", "status");

-- CreateIndex
CREATE INDEX "MailDelivery_createdAt_status_idx" ON "MailDelivery"("createdAt", "status");

-- AddForeignKey
ALTER TABLE "SellerMailPolicy" ADD CONSTRAINT "SellerMailPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 값 범위(한 행 설정, 음수 금지)
ALTER TABLE "PlatformMailSetting" ADD CONSTRAINT "PlatformMailSetting_single_row" CHECK ("id" = 1);
ALTER TABLE "PlatformMailSetting" ADD CONSTRAINT "PlatformMailSetting_nonneg" CHECK ("overageUnitPrice" >= 0 AND "platformDailyLimit" >= 0 AND "platformMonthlyLimit" >= 0);
ALTER TABLE "SellerMailPolicy" ADD CONSTRAINT "SellerMailPolicy_cap_nonneg" CHECK ("overageMonthlyCap" >= 0);
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_mailMonthlyQuota_nonneg" CHECK ("mailMonthlyQuota" >= 0);
