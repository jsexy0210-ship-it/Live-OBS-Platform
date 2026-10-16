ALTER TABLE "BuyerInquiry" ADD COLUMN "orderId" UUID;

CREATE INDEX "BuyerInquiry_sellerId_orderId_idx" ON "BuyerInquiry"("sellerId", "orderId");

ALTER TABLE "BuyerInquiry" ADD CONSTRAINT "BuyerInquiry_sellerId_orderId_fkey"
  FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
