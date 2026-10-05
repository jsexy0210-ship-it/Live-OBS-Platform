-- CreateTable
CREATE TABLE "SellerNotificationSeen" (
    "sellerUserId" UUID NOT NULL,
    "seenAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerNotificationSeen_pkey" PRIMARY KEY ("sellerUserId")
);
