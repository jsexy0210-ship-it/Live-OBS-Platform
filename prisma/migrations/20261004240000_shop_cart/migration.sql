-- 구매자 장바구니(SH-004). 줄당 수량 1~99는 CHECK로도 막는다.

CREATE TABLE "CartItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CartItem_sellerId_buyerMemberId_idx" ON "CartItem"("sellerId", "buyerMemberId");

-- CreateIndex
CREATE INDEX "CartItem_sellerId_optionId_idx" ON "CartItem"("sellerId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_buyerMemberId_optionId_key" ON "CartItem"("buyerMemberId", "optionId");

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_sellerId_optionId_fkey" FOREIGN KEY ("sellerId", "optionId") REFERENCES "ProductOption"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_quantity_check" CHECK ("quantity" BETWEEN 1 AND 99);
