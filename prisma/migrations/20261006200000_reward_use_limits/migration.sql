-- AlterTable
ALTER TABLE "RewardPolicy" ADD COLUMN "useMinAmount" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN "useMaxRatio" INTEGER NOT NULL DEFAULT 0;

-- 사용 조건 범위(서버 검증과 같은 기준)
ALTER TABLE "RewardPolicy" ADD CONSTRAINT "RewardPolicy_useMaxRatio_check" CHECK ("useMaxRatio" BETWEEN 0 AND 100);
ALTER TABLE "RewardPolicy" ADD CONSTRAINT "RewardPolicy_useMinAmount_check" CHECK ("useMinAmount" BETWEEN 10 AND 1000000 AND "useMinAmount" % 10 = 0);
