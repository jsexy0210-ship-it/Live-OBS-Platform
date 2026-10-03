-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- AlterTable
ALTER TABLE "IdentityVerification" ADD COLUMN     "attemptKeyHash" TEXT,
ADD COLUMN     "sendStartedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "IdentityVerification_sellerId_attemptKeyHash_key" ON "IdentityVerification"("sellerId", "attemptKeyHash");

COMMIT;
