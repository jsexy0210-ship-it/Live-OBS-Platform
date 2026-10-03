-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- CreateEnum
CREATE TYPE "RewardEarnTiming" AS ENUM ('ON_PAYMENT', 'ON_DELIVERY');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "purchaseConfirmedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "RewardPolicy" ADD COLUMN     "earnTiming" "RewardEarnTiming" NOT NULL DEFAULT 'ON_DELIVERY';

-- AlterTable
ALTER TABLE "SellerOrderPolicy" ADD COLUMN     "autoConfirmDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "autoConfirmEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "autoDeliverDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "autoDeliverEnabled" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
