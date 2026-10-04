-- CreateIndex
CREATE INDEX "BuyerMember_sellerId_createdAt_idx" ON "BuyerMember"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "BuyerMember_sellerId_deletedAt_idx" ON "BuyerMember"("sellerId", "deletedAt");

