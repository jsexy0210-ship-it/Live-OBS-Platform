-- AlterTable
ALTER TABLE "BuyerPurchaseRestriction" ADD COLUMN     "note" TEXT;

-- CreateTable
CREATE TABLE "MemberMemo" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberMemo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberMemo_sellerId_buyerMemberId_key" ON "MemberMemo"("sellerId", "buyerMemberId");

-- AddForeignKey
ALTER TABLE "MemberMemo" ADD CONSTRAINT "MemberMemo_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

