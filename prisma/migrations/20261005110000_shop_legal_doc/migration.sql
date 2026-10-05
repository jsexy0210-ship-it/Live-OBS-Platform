-- CreateEnum
CREATE TYPE "ShopLegalKind" AS ENUM ('TERMS', 'PRIVACY');

-- CreateTable
CREATE TABLE "ShopLegalDoc" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "kind" "ShopLegalKind" NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "effectiveOn" DATE,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopLegalDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopLegalDoc_sellerId_kind_key" ON "ShopLegalDoc"("sellerId", "kind");

-- AddForeignKey
ALTER TABLE "ShopLegalDoc" ADD CONSTRAINT "ShopLegalDoc_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

