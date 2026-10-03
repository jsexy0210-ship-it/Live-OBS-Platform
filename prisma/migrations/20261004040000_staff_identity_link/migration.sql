-- 직원 휴대폰·본인확인 연결(직원 셀프 아이디·비밀번호 찾기)과 본인확인 목적 추가(2026-10-03 대표님 결정, PRODUCT_SCOPE 로그인)
-- AlterEnum


ALTER TYPE "IdentityVerificationPurpose" ADD VALUE 'STAFF_LINK';
ALTER TYPE "IdentityVerificationPurpose" ADD VALUE 'ACCOUNT_RECOVERY';

-- AlterTable
ALTER TABLE "SellerUser" ADD COLUMN     "identityCiHash" TEXT,
ADD COLUMN     "identityLinkedAt" TIMESTAMPTZ(3),
ADD COLUMN     "phone" TEXT;

-- CreateIndex
CREATE INDEX "SellerUser_identityCiHash_idx" ON "SellerUser"("identityCiHash");

