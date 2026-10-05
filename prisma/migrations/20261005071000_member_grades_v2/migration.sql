-- 회원 등급 v2: 산정 기준(기간·주기·강등 방식), 고정 기간·사유, 등급 삭제 이동 기록
-- CreateEnum
CREATE TYPE "MemberGradeCadence" AS ENUM ('MONTHLY', 'WEEKLY', 'DAILY');

-- CreateEnum
CREATE TYPE "MemberGradeDemotion" AS ENUM ('STEP', 'IMMEDIATE', 'NONE');

-- AlterEnum
ALTER TYPE "MemberGradeChangeReason" ADD VALUE 'GRADE_REMOVED';

-- AlterTable
ALTER TABLE "MemberGradeOverride" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "until" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "MemberGradePolicy" ADD COLUMN     "cadence" "MemberGradeCadence" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "demotion" "MemberGradeDemotion" NOT NULL DEFAULT 'STEP',
ADD COLUMN     "windowMonths" INTEGER NOT NULL DEFAULT 6;


-- 기간은 0(누적)·3·6·12개월, 사유는 100자 이내, 실행 키는 월(YYYY-MM)·주(YYYY-Www)·일(YYYY-MM-DD)
ALTER TABLE "MemberGradePolicy" ADD CONSTRAINT "MemberGradePolicy_windowMonths_values" CHECK ("windowMonths" IN (0, 3, 6, 12));
ALTER TABLE "MemberGradeOverride" ADD CONSTRAINT "MemberGradeOverride_reason_len" CHECK ("reason" IS NULL OR char_length("reason") <= 100);
ALTER TABLE "MemberGradeRun" DROP CONSTRAINT "MemberGradeRun_monthKey_format";
ALTER TABLE "MemberGradeRun" ADD CONSTRAINT "MemberGradeRun_monthKey_format" CHECK ("monthKey" ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-[0-9]{2})?$' OR "monthKey" ~ '^[0-9]{4}-W[0-9]{2}$');
