-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "autoCancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "paymentDueAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "SellerOrderPolicy" (
    "sellerId" UUID NOT NULL,
    "paymentDueHours" INTEGER NOT NULL DEFAULT 24,
    "unpaidRestrictionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerOrderPolicy_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "BuyerPurchaseRestriction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "liftedAt" TIMESTAMPTZ(3),
    "liftedById" UUID,

    CONSTRAINT "BuyerPurchaseRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuyerPurchaseRestriction_sellerId_buyerMemberId_startsAt_idx" ON "BuyerPurchaseRestriction"("sellerId", "buyerMemberId", "startsAt");

-- CreateIndex
CREATE INDEX "Order_status_paymentDueAt_idx" ON "Order"("status", "paymentDueAt");

-- CreateIndex
CREATE INDEX "Order_sellerId_buyerMemberId_autoCancelledAt_idx" ON "Order"("sellerId", "buyerMemberId", "autoCancelledAt");

-- AddForeignKey
ALTER TABLE "SellerOrderPolicy" ADD CONSTRAINT "SellerOrderPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPurchaseRestriction" ADD CONSTRAINT "BuyerPurchaseRestriction_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPurchaseRestriction" ADD CONSTRAINT "BuyerPurchaseRestriction_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
