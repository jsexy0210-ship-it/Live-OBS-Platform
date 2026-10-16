-- SA-021 선택 일괄 「배송 준비로 변경」: 주문 표식 시각과 구매자 안내 기록 종류(lib/server/orders/bulk.ts)
ALTER TYPE "OrderNotificationKind" ADD VALUE 'SHIPPING_PREPARED';

ALTER TABLE "Order" ADD COLUMN "shippingPreparedAt" TIMESTAMPTZ(3);
