-- CreateTable
CREATE TABLE "OrderConsent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "agreedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderConsent_sellerId_orderId_idx" ON "OrderConsent"("sellerId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderConsent_orderId_kind_key" ON "OrderConsent"("orderId", "kind");

-- AddForeignKey
ALTER TABLE "OrderConsent" ADD CONSTRAINT "OrderConsent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsent" ADD CONSTRAINT "OrderConsent_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
