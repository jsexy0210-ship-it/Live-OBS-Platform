-- CreateEnum
CREATE TYPE "BulkJobKind" AS ENUM ('PRODUCT_IMPORT');

-- CreateEnum
CREATE TYPE "BulkJobStatus" AS ENUM ('PREVIEW', 'COMMITTING', 'COMMITTED', 'UNDONE');

-- CreateTable
CREATE TABLE "BulkJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "kind" "BulkJobKind" NOT NULL,
    "status" "BulkJobStatus" NOT NULL DEFAULT 'PREVIEW',
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL,
    "productCount" INTEGER NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL DEFAULT '[]',
    "createdProductIds" JSONB NOT NULL DEFAULT '[]',
    "failures" JSONB NOT NULL DEFAULT '[]',
    "keptCount" INTEGER NOT NULL DEFAULT 0,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMPTZ(3),
    "undoUntil" TIMESTAMPTZ(3),
    "undoneAt" TIMESTAMPTZ(3),

    CONSTRAINT "BulkJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkJob_sellerId_createdAt_idx" ON "BulkJob"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "BulkJob" ADD CONSTRAINT "BulkJob_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 일괄 등록은 파트너스 직원·관리자만 한다(구매자 회원 id가 행위자 칸에 들어오지 않게 막는다, memberData.ts MEMBER_REFERENCE_POLICY)
ALTER TABLE "BulkJob" ADD CONSTRAINT "BulkJob_actor_not_buyer_check" CHECK ("actorType" <> 'BUYER');
