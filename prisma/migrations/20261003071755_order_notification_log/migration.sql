-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- CreateEnum
CREATE TYPE "OrderNotificationKind" AS ENUM ('PAYMENT_DUE_SOON');

-- CreateEnum
CREATE TYPE "OrderNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "OrderNotification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "OrderNotificationKind" NOT NULL,
    "status" "OrderNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderNotification_sellerId_kind_status_idx" ON "OrderNotification"("sellerId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrderNotification_orderId_kind_key" ON "OrderNotification"("orderId", "kind");

-- AddForeignKey
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
