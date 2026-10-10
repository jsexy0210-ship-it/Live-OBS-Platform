CREATE TYPE "SubscriptionPriceNoticeChannel" AS ENUM ('MAIL', 'ALIMTALK', 'PARTNERS_NOTICE');
CREATE TYPE "SubscriptionPriceNoticeStatus" AS ENUM ('PENDING', 'FAILED', 'SENT');
CREATE TABLE "SubscriptionPriceNotice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL,
    "subscriptionStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "priceChangeId" UUID NOT NULL,
    "channel" "SubscriptionPriceNoticeChannel" NOT NULL,
    "status" "SubscriptionPriceNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMPTZ(3),
    "deliveryReference" TEXT,
    CONSTRAINT "SubscriptionPriceNotice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionPriceNotice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "SellerSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionPriceNotice_priceChangeId_fkey" FOREIGN KEY ("priceChangeId") REFERENCES "SubscriptionPriceChange"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SubscriptionPriceNotice_receipt_key"
ON "SubscriptionPriceNotice"("subscriptionId", "subscriptionStartedAt", "priceChangeId", "channel");
CREATE INDEX "SubscriptionPriceNotice_priceChangeId_idx" ON "SubscriptionPriceNotice"("priceChangeId");
