-- SA-060 도메인 연결: 소유 확인 값·마지막 확인 시각
ALTER TABLE "SellerDomain" ADD COLUMN "verifyToken" TEXT, ADD COLUMN "lastCheckedAt" TIMESTAMPTZ(3);
UPDATE "SellerDomain" SET "verifyToken" = replace(gen_random_uuid()::text, '-', '') WHERE "verifyToken" IS NULL;
ALTER TABLE "SellerDomain" ALTER COLUMN "verifyToken" SET NOT NULL;
ALTER TABLE "SellerDomain" ALTER COLUMN "verifyToken" SET DEFAULT replace((gen_random_uuid())::text, '-', '');
