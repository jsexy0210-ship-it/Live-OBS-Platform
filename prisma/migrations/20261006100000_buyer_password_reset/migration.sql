-- CreateTable
CREATE TABLE "BuyerPasswordReset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerPasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerPasswordReset_tokenHash_key" ON "BuyerPasswordReset"("tokenHash");

-- CreateIndex
CREATE INDEX "BuyerPasswordReset_sellerId_buyerMemberId_idx" ON "BuyerPasswordReset"("sellerId", "buyerMemberId");

-- AddForeignKey
ALTER TABLE "BuyerPasswordReset" ADD CONSTRAINT "BuyerPasswordReset_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerPasswordReset" ADD CONSTRAINT "BuyerPasswordReset_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
