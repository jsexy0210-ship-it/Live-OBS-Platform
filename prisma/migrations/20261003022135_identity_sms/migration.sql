-- 휴대폰 본인확인(문자) 전환 (대표님 결정 2026-10-03, PRODUCT_SCOPE 「휴대폰 본인확인 방식」)
-- CreateEnum
CREATE TYPE "IdentityVerificationMethod" AS ENUM ('PASS_APP', 'SMS');

-- AlterTable
-- 기존 행은 실제로 쓴 방식(PASS 앱 방식 흐름, 공급자는 기존 provider 값 그대로·지금은 fake뿐)을 남긴다. SMS로 바꿔 적지 않는다.
ALTER TABLE "IdentityVerification" ADD COLUMN     "lastSentAt" TIMESTAMPTZ(3),
ADD COLUMN     "method" "IdentityVerificationMethod" NOT NULL DEFAULT 'PASS_APP',
ADD COLUMN     "otpFailCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requestedPhone" TEXT,
ADD COLUMN     "sendCount" INTEGER NOT NULL DEFAULT 0;

-- 새 행은 코드가 방식을 꼭 적는다(기본값 없음)
ALTER TABLE "IdentityVerification" ALTER COLUMN "method" DROP DEFAULT;
