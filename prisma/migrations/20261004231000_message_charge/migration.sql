-- CreateEnum
CREATE TYPE "MessageChargeStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "MessageCharge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "MessageChargeStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "receiptUrl" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MessageCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageCharge_status_createdAt_idx" ON "MessageCharge"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageCharge_sellerId_idempotencyKey_key" ON "MessageCharge"("sellerId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "MessageCharge" ADD CONSTRAINT "MessageCharge_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 충전 금액은 양수
ALTER TABLE "MessageCharge" ADD CONSTRAINT "MessageCharge_amount_positive" CHECK ("amount" > 0);
