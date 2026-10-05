-- 구매자 찜(SH-034)

CREATE TABLE "WishItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WishItem_sellerId_buyerMemberId_createdAt_idx" ON "WishItem"("sellerId", "buyerMemberId", "createdAt");

-- CreateIndex
CREATE INDEX "WishItem_sellerId_productId_idx" ON "WishItem"("sellerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "WishItem_buyerMemberId_productId_key" ON "WishItem"("buyerMemberId", "productId");

-- AddForeignKey
ALTER TABLE "WishItem" ADD CONSTRAINT "WishItem_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishItem" ADD CONSTRAINT "WishItem_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishItem" ADD CONSTRAINT "WishItem_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

