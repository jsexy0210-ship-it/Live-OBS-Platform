-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "rejectedAt" TIMESTAMPTZ(3),
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "IdentityVerification" ADD COLUMN     "requestIp" TEXT;

-- 판매자 가입 PASS 시작 횟수 세기(용도·IP·시각)
CREATE INDEX "IdentityVerification_purpose_requestIp_createdAt_idx" ON "IdentityVerification"("purpose", "requestIp", "createdAt");
