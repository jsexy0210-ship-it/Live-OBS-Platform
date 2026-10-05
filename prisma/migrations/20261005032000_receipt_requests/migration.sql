-- 현금영수증·세금계산서 신청·발행 이력(lib/server/receipts/service.ts)
CREATE TYPE "ReceiptKind" AS ENUM ('CASH_RECEIPT_INCOME', 'CASH_RECEIPT_EXPENSE', 'TAX_INVOICE');
CREATE TYPE "ReceiptIssueStatus" AS ENUM ('PENDING', 'ISSUED', 'FAILED', 'CANCELLED');

CREATE TABLE "OrderReceiptRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "kind" "ReceiptKind" NOT NULL,
    "identitySealed" TEXT NOT NULL,
    "identityLast4" TEXT NOT NULL,
    "taxInfo" JSONB,
    "withdrawnAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderReceiptRequest_pkey" PRIMARY KEY ("id"),
    -- 세금계산서는 사업자 정보가 있어야 한다
    CONSTRAINT "OrderReceiptRequest_tax_info_check" CHECK ("kind" <> 'TAX_INVOICE' OR "taxInfo" IS NOT NULL)
);

CREATE TABLE "ReceiptIssue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "status" "ReceiptIssueStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "providerKey" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReceiptIssue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReceiptIssue_amount_check" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "OrderReceiptRequest_sellerId_id_key" ON "OrderReceiptRequest"("sellerId", "id");
CREATE INDEX "OrderReceiptRequest_sellerId_createdAt_idx" ON "OrderReceiptRequest"("sellerId", "createdAt");
CREATE INDEX "OrderReceiptRequest_sellerId_orderId_idx" ON "OrderReceiptRequest"("sellerId", "orderId");
-- 주문당 철회하지 않은 신청은 1건
CREATE UNIQUE INDEX "OrderReceiptRequest_one_active_per_order" ON "OrderReceiptRequest"("orderId") WHERE "withdrawnAt" IS NULL;
CREATE INDEX "ReceiptIssue_sellerId_status_createdAt_idx" ON "ReceiptIssue"("sellerId", "status", "createdAt");
CREATE INDEX "ReceiptIssue_sellerId_requestId_idx" ON "ReceiptIssue"("sellerId", "requestId");

ALTER TABLE "OrderReceiptRequest" ADD CONSTRAINT "OrderReceiptRequest_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderReceiptRequest" ADD CONSTRAINT "OrderReceiptRequest_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceiptIssue" ADD CONSTRAINT "ReceiptIssue_sellerId_requestId_fkey" FOREIGN KEY ("sellerId", "requestId") REFERENCES "OrderReceiptRequest"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
