-- 한 번에 적용(중간 실패 시 일부만 남지 않게)
BEGIN;

-- CreateIndex
CREATE INDEX "Order_sellerId_refundedAt_idx" ON "Order"("sellerId", "refundedAt");

-- CreateIndex
CREATE INDEX "Order_sellerId_autoCancelledAt_idx" ON "Order"("sellerId", "autoCancelledAt");

COMMIT;
