-- 적립금 소멸 30일 전 안내 「보냈음」 기록
CREATE TABLE "RewardExpiryNotice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "lastEarnAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "OrderNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardExpiryNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RewardExpiryNotice_buyerMemberId_lastEarnAt_key" ON "RewardExpiryNotice"("buyerMemberId", "lastEarnAt");
CREATE INDEX "RewardExpiryNotice_sellerId_status_idx" ON "RewardExpiryNotice"("sellerId", "status");

ALTER TABLE "RewardExpiryNotice" ADD CONSTRAINT "RewardExpiryNotice_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
