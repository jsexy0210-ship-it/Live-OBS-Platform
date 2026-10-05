-- 구매자 환불 요청(lib/server/payments/refundRequest.ts)
CREATE TYPE "RefundRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "RefundRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "ReturnReason" NOT NULL,
    "reasonText" TEXT NOT NULL DEFAULT '',
    "items" JSONB,
    "rejectReason" TEXT,
    "refundId" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id"),
    -- 거절은 사유가 있어야 하고, 승인은 이어진 환불이 있어야 한다
    CONSTRAINT "RefundRequest_decision_check" CHECK (("status" <> 'REJECTED' OR "rejectReason" IS NOT NULL) AND ("status" <> 'APPROVED' OR "refundId" IS NOT NULL))
);

CREATE UNIQUE INDEX "RefundRequest_sellerId_id_key" ON "RefundRequest"("sellerId", "id");
CREATE INDEX "RefundRequest_sellerId_status_createdAt_idx" ON "RefundRequest"("sellerId", "status", "createdAt");
CREATE INDEX "RefundRequest_sellerId_orderId_idx" ON "RefundRequest"("sellerId", "orderId");
CREATE INDEX "RefundRequest_sellerId_buyerMemberId_createdAt_idx" ON "RefundRequest"("sellerId", "buyerMemberId", "createdAt");
-- 주문당 진행 중인 요청은 1건
CREATE UNIQUE INDEX "RefundRequest_one_active_per_order" ON "RefundRequest"("orderId") WHERE "status" = 'REQUESTED';

ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
