-- 회원 등급 자동 재산정(member-grades): 승급 기준액, 고정 회원, 변경 기록, 월 1회 실행 기록
-- CreateEnum
CREATE TYPE "MemberGradeChangeReason" AS ENUM ('AUTO_UP', 'AUTO_DOWN', 'MANUAL');

-- AlterTable
ALTER TABLE "MemberGrade" ADD COLUMN     "minAmount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MemberGradePolicy" (
    "sellerId" UUID NOT NULL,
    "autoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberGradePolicy_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "MemberGradeOverride" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "staffId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberGradeOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberGradeHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "fromName" TEXT NOT NULL,
    "toName" TEXT NOT NULL,
    "reason" "MemberGradeChangeReason" NOT NULL,
    "amount" INTEGER,
    "staffId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberGradeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberGradeRun" (
    "sellerId" UUID NOT NULL,
    "monthKey" TEXT NOT NULL,
    "promoted" INTEGER NOT NULL DEFAULT 0,
    "demoted" INTEGER NOT NULL DEFAULT 0,
    "ranAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberGradeRun_pkey" PRIMARY KEY ("sellerId","monthKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberGradeOverride_buyerMemberId_key" ON "MemberGradeOverride"("buyerMemberId");

-- CreateIndex
CREATE INDEX "MemberGradeOverride_sellerId_idx" ON "MemberGradeOverride"("sellerId");

-- CreateIndex
CREATE INDEX "MemberGradeHistory_sellerId_createdAt_idx" ON "MemberGradeHistory"("sellerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MemberGradeHistory_sellerId_buyerMemberId_idx" ON "MemberGradeHistory"("sellerId", "buyerMemberId");

-- AddForeignKey
ALTER TABLE "MemberGradePolicy" ADD CONSTRAINT "MemberGradePolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberGradeOverride" ADD CONSTRAINT "MemberGradeOverride_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberGradeOverride" ADD CONSTRAINT "MemberGradeOverride_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberGradeHistory" ADD CONSTRAINT "MemberGradeHistory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberGradeHistory" ADD CONSTRAINT "MemberGradeHistory_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberGradeRun" ADD CONSTRAINT "MemberGradeRun_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 값 범위: 기준액은 0 이상, 승급 기록 금액도 0 이상
ALTER TABLE "MemberGrade" ADD CONSTRAINT "MemberGrade_minAmount_range" CHECK ("minAmount" >= 0 AND "minAmount" <= 2000000000);
-- 월 키는 YYYY-MM
ALTER TABLE "MemberGradeRun" ADD CONSTRAINT "MemberGradeRun_monthKey_format" CHECK ("monthKey" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
