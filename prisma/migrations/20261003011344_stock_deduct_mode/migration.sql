-- CreateEnum
CREATE TYPE "StockDeductMode" AS ENUM ('ORDER', 'PAYMENT');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "stockDeductedAt" TIMESTAMPTZ(3),
ADD COLUMN     "stockRestoredAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "stockDeductMode" "StockDeductMode" NOT NULL DEFAULT 'PAYMENT';

-- AlterTable
ALTER TABLE "SellerOrderPolicy" ADD COLUMN     "restockOnCancel" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "SellerShippingPolicy" ADD COLUMN     "freeShipping" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "note" TEXT;

-- 기존 주문 품목: 결제 때 재고를 뺀 품목(결제·환불 상태이고 재고 부족 표시가 없는 주문)은 결제 시각을 차감 시각으로 채운다.
UPDATE "OrderItem" AS i SET "stockDeductedAt" = o."paidAt"
FROM "Order" AS o
WHERE o."sellerId" = i."sellerId" AND o."id" = i."orderId"
  AND o."status" IN ('PAID', 'REFUNDED') AND o."stockShortageAt" IS NULL AND o."paidAt" IS NOT NULL;

-- 환불 때 재고를 되돌린 품목은 그 이력 시각을 복구 시각으로 채운다(같은 품목을 두 번 되돌리지 않게).
UPDATE "OrderItem" AS i SET "stockRestoredAt" = m."createdAt"
FROM "StockMovement" AS m
WHERE m."sellerId" = i."sellerId" AND m."orderId" = i."orderId" AND m."optionId" = i."optionId" AND m."reason" = 'REFUND';
