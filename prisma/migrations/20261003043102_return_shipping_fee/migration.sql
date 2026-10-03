-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- CreateEnum
CREATE TYPE "RefundFault" AS ENUM ('BUYER', 'SELLER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundAmount" INTEGER,
ADD COLUMN     "refundFault" "RefundFault",
ADD COLUMN     "returnFeeDeducted" INTEGER,
ADD COLUMN     "returnFeeSnapshot" INTEGER;

-- AlterTable
ALTER TABLE "SellerShippingPolicy" ADD COLUMN     "exchangeFee" INTEGER NOT NULL DEFAULT 6000,
ADD COLUMN     "returnFee" INTEGER NOT NULL DEFAULT 3000;

COMMIT;
