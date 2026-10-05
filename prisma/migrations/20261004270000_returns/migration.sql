-- 교환·반품(shop-returns): ReturnRequest·ReturnRequestItem·ReturnRequestImage
-- CreateEnum
CREATE TYPE "ReturnKind" AS ENUM ('RETURN', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('CHANGE_OF_MIND', 'DEFECTIVE', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'OTHER');

-- AlterEnum
ALTER TYPE "StockMovementReason" ADD VALUE 'EXCHANGE';

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "kind" "ReturnKind" NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "ReturnReason" NOT NULL,
    "reasonText" TEXT NOT NULL DEFAULT '',
    "fault" "RefundFault",
    "rejectReason" TEXT,
    "returnCourier" TEXT,
    "returnTrackingNumber" TEXT,
    "restocked" BOOLEAN NOT NULL DEFAULT false,
    "exchangeCourier" TEXT,
    "exchangeTrackingNumber" TEXT,
    "refundAmount" INTEGER,
    "acceptedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "rejectedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequestItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "returnRequestId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ReturnRequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequestImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "returnRequestId" UUID,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnRequestImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnRequest_sellerId_status_createdAt_idx" ON "ReturnRequest"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnRequest_sellerId_orderId_idx" ON "ReturnRequest"("sellerId", "orderId");

-- CreateIndex
CREATE INDEX "ReturnRequest_sellerId_buyerMemberId_createdAt_idx" ON "ReturnRequest"("sellerId", "buyerMemberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_sellerId_id_key" ON "ReturnRequest"("sellerId", "id");

-- CreateIndex
CREATE INDEX "ReturnRequestItem_sellerId_orderItemId_idx" ON "ReturnRequestItem"("sellerId", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequestItem_returnRequestId_orderItemId_key" ON "ReturnRequestItem"("returnRequestId", "orderItemId");

-- CreateIndex
CREATE INDEX "ReturnRequestImage_sellerId_returnRequestId_idx" ON "ReturnRequestImage"("sellerId", "returnRequestId");

-- CreateIndex
CREATE INDEX "ReturnRequestImage_sellerId_buyerMemberId_returnRequestId_idx" ON "ReturnRequestImage"("sellerId", "buyerMemberId", "returnRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequestImage_sellerId_id_key" ON "ReturnRequestImage"("sellerId", "id");

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_sellerId_returnRequestId_fkey" FOREIGN KEY ("sellerId", "returnRequestId") REFERENCES "ReturnRequest"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_sellerId_orderItemId_fkey" FOREIGN KEY ("sellerId", "orderItemId") REFERENCES "OrderItem"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestImage" ADD CONSTRAINT "ReturnRequestImage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestImage" ADD CONSTRAINT "ReturnRequestImage_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequestImage" ADD CONSTRAINT "ReturnRequestImage_sellerId_returnRequestId_fkey" FOREIGN KEY ("sellerId", "returnRequestId") REFERENCES "ReturnRequest"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 주문당 진행 중인 신청은 1건(동시 신청을 DB가 막는다)
CREATE UNIQUE INDEX "ReturnRequest_one_active_per_order" ON "ReturnRequest"("sellerId", "orderId") WHERE "status" IN ('REQUESTED', 'ACCEPTED', 'RECEIVED');

-- 상태와 시각·값이 어긋난 행을 막는다
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_reasonText_len" CHECK (char_length("reasonText") <= 500);
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_status_fields" CHECK (
  ("status" = 'REQUESTED' AND "acceptedAt" IS NULL AND "receivedAt" IS NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "fault" IS NOT NULL AND "receivedAt" IS NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'RECEIVED' AND "acceptedAt" IS NOT NULL AND "fault" IS NOT NULL AND "receivedAt" IS NOT NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'COMPLETED' AND "acceptedAt" IS NOT NULL AND "fault" IS NOT NULL AND "receivedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'REJECTED' AND "rejectedAt" IS NOT NULL AND "rejectReason" IS NOT NULL AND "acceptedAt" IS NULL AND "completedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL)
);
-- 완료한 반품은 환불 금액, 완료한 교환은 교환 송장이 있고, 반대 종류의 값은 없다
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_completed_result" CHECK (
  "status" <> 'COMPLETED'
  OR ("kind" = 'RETURN' AND "refundAmount" IS NOT NULL AND "refundAmount" >= 0 AND "exchangeCourier" IS NULL AND "exchangeTrackingNumber" IS NULL)
  OR ("kind" = 'EXCHANGE' AND "refundAmount" IS NULL AND "exchangeCourier" IS NOT NULL AND "exchangeTrackingNumber" IS NOT NULL)
);
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_kind_fields" CHECK ("kind" = 'EXCHANGE' OR ("exchangeCourier" IS NULL AND "exchangeTrackingNumber" IS NULL));
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_quantity_positive" CHECK ("quantity" > 0);
