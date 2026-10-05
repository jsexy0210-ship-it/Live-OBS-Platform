-- 마스터 청구·결제 내역(MA-024): 기간 조회와 구독별 최신 청구 판정용 인덱스
CREATE INDEX "SubscriptionPayment_createdAt_idx" ON "SubscriptionPayment"("createdAt");
CREATE INDEX "SubscriptionPayment_subscriptionId_createdAt_idx" ON "SubscriptionPayment"("subscriptionId", "createdAt");
