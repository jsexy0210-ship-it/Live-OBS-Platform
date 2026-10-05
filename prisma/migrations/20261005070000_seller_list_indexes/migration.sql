-- 마스터 파트너스 목록(MA-011) 집계를 쇼핑몰별 인덱스 조회로 바꾸기 위한 인덱스
CREATE INDEX "Order_sellerId_paidAt_idx" ON "Order"("sellerId", "paidAt");
CREATE INDEX "BroadcastSession_sellerId_startedAt_idx" ON "BroadcastSession"("sellerId", "startedAt");
CREATE INDEX "Payment_sellerId_approvedAt_idx" ON "Payment"("sellerId", "approvedAt");
CREATE INDEX "Payment_sellerId_status_updatedAt_idx" ON "Payment"("sellerId", "status", "updatedAt");
