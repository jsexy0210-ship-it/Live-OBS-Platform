-- CreateEnum
CREATE TYPE "RestockAlertStatus" AS ENUM ('WAITING', 'QUEUED', 'SENT');

-- CreateTable
CREATE TABLE "RestockAlert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "status" "RestockAlertStatus" NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restockedAt" TIMESTAMPTZ(3),
    "notifyAt" TIMESTAMPTZ(3),
    "notifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RestockAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestockAlert_sellerId_productId_status_idx" ON "RestockAlert"("sellerId", "productId", "status");

-- CreateIndex
CREATE INDEX "RestockAlert_sellerId_status_notifyAt_idx" ON "RestockAlert"("sellerId", "status", "notifyAt");

-- CreateIndex
CREATE UNIQUE INDEX "RestockAlert_buyerMemberId_productId_key" ON "RestockAlert"("buyerMemberId", "productId");

-- AddForeignKey
ALTER TABLE "RestockAlert" ADD CONSTRAINT "RestockAlert_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockAlert" ADD CONSTRAINT "RestockAlert_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockAlert" ADD CONSTRAINT "RestockAlert_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

