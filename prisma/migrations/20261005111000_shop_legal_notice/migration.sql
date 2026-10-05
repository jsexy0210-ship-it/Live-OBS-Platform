-- CreateEnum
CREATE TYPE "ShopEscrowKind" AS ENUM ('NONE', 'ESCROW', 'INSURANCE');

-- CreateTable
CREATE TABLE "ShopLegalNotice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "csPhone" TEXT NOT NULL DEFAULT '',
    "csEmail" TEXT NOT NULL DEFAULT '',
    "csHours" TEXT NOT NULL DEFAULT '',
    "escrowKind" "ShopEscrowKind" NOT NULL DEFAULT 'NONE',
    "escrowProvider" TEXT NOT NULL DEFAULT '',
    "escrowUrl" TEXT NOT NULL DEFAULT '',
    "minorNotice" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopLegalNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopLegalNotice_sellerId_key" ON "ShopLegalNotice"("sellerId");

-- AddForeignKey
ALTER TABLE "ShopLegalNotice" ADD CONSTRAINT "ShopLegalNotice_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

