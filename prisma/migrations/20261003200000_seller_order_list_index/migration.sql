-- CreateIndex
CREATE INDEX "Order_sellerId_createdAt_id_idx" ON "Order"("sellerId", "createdAt" DESC, "id" DESC);

