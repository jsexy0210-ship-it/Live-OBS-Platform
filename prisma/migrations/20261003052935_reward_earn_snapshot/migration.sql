-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "rewardEarnAmount" INTEGER,
ADD COLUMN     "rewardEarnTiming" "RewardEarnTiming",
ADD COLUMN     "rewardGradeId" UUID,
ADD COLUMN     "rewardRate" DOUBLE PRECISION;

COMMIT;
