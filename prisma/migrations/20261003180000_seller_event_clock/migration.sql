-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- AlterTable
ALTER TABLE "SellerOrderPolicy" ADD COLUMN     "lastEventClockAt" TIMESTAMPTZ(3);

COMMIT;
