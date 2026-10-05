-- 외부 쇼핑몰 주문 저장(ExternalOrder)과 대기열 항목의 외부 주문 참조: 내부 주문 또는 외부 주문 중 정확히 한쪽만 채운다
-- AlterTable
ALTER TABLE "QueueItem" ADD COLUMN     "externalLineNo" INTEGER,
ADD COLUMN     "externalOrderId" UUID,
ALTER COLUMN "orderId" DROP NOT NULL,
ALTER COLUMN "orderItemId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ExternalOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "buyerLabel" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalOrder_sellerId_receivedAt_idx" ON "ExternalOrder"("sellerId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrder_sellerId_id_key" ON "ExternalOrder"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrder_connectionId_externalOrderId_key" ON "ExternalOrder"("connectionId", "externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "QueueItem_sellerId_externalOrderId_externalLineNo_key" ON "QueueItem"("sellerId", "externalOrderId", "externalLineNo");

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_sellerId_externalOrderId_fkey" FOREIGN KEY ("sellerId", "externalOrderId") REFERENCES "ExternalOrder"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrder" ADD CONSTRAINT "ExternalOrder_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrder" ADD CONSTRAINT "ExternalOrder_sellerId_connectionId_fkey" FOREIGN KEY ("sellerId", "connectionId") REFERENCES "ExternalShopConnection"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 대기열 항목의 출처는 내부 주문(주문·품목)이거나 외부 주문(외부 주문·줄 번호) 중 정확히 한쪽이다
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_source_check" CHECK (
  ("orderId" IS NOT NULL AND "orderItemId" IS NOT NULL AND "externalOrderId" IS NULL AND "externalLineNo" IS NULL)
  OR ("orderId" IS NULL AND "orderItemId" IS NULL AND "externalOrderId" IS NOT NULL AND "externalLineNo" IS NOT NULL)
);
