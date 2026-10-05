-- 부분 환불(queue/service.ts refundOrder): 품목별 환불 수량과 환불 1건 기록
ALTER TABLE "OrderItem" ADD COLUMN "refundedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_refundedQuantity_check" CHECK ("refundedQuantity" >= 0 AND "refundedQuantity" <= "quantity");

CREATE TABLE "OrderRefund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "fault" "RefundFault",
    "reason" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "itemsAmount" INTEGER NOT NULL,
    "shippingRefunded" INTEGER NOT NULL,
    "refundAmount" INTEGER NOT NULL,
    "returnFeeDeducted" INTEGER NOT NULL,
    "rewardReturn" INTEGER NOT NULL,
    "rewardRevoke" INTEGER NOT NULL,
    "rewardRevokeKind" TEXT,
    "isFinal" BOOLEAN NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderRefund_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderRefund_amounts_check" CHECK ("seq" >= 1 AND "itemsAmount" >= 0 AND "shippingRefunded" >= 0 AND "refundAmount" >= 0 AND "returnFeeDeducted" >= 0 AND "rewardReturn" >= 0 AND "rewardRevoke" >= 0)
);

CREATE UNIQUE INDEX "OrderRefund_sellerId_id_key" ON "OrderRefund"("sellerId", "id");
CREATE UNIQUE INDEX "OrderRefund_orderId_seq_key" ON "OrderRefund"("orderId", "seq");
CREATE INDEX "OrderRefund_sellerId_orderId_idx" ON "OrderRefund"("sellerId", "orderId");

ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
