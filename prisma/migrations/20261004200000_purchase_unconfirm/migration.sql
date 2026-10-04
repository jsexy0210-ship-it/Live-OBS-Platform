-- 판매자가 구매 확정을 취소한 시각(자동 구매 확정이 다시 확정하지 않게)
ALTER TABLE "Order" ADD COLUMN "purchaseUnconfirmedAt" TIMESTAMPTZ(3);
