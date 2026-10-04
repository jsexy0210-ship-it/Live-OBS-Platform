-- 구매자 주문 결제(나이스페이 테스트 결제, 기반-결제 1단계)

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('READY', 'APPROVING', 'PAID', 'FAILED', 'CANCELLED', 'PARTIAL_CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentCancelStatus" AS ENUM ('REQUESTED', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'READY',
    "amount" INTEGER NOT NULL,
    "cancelledAmount" INTEGER NOT NULL DEFAULT 0,
    "pgTid" TEXT,
    "failureCode" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCancel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "PaymentCancelStatus" NOT NULL DEFAULT 'REQUESTED',
    "pgCancelledTid" TEXT,
    "failureCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastTriedAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentCancel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_pgTid_key" ON "Payment"("pgTid");

-- CreateIndex
CREATE INDEX "Payment_sellerId_orderId_idx" ON "Payment"("sellerId", "orderId");

-- CreateIndex
CREATE INDEX "Payment_status_updatedAt_idx" ON "Payment"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_sellerId_id_key" ON "Payment"("sellerId", "id");

-- CreateIndex
CREATE INDEX "PaymentCancel_status_lastTriedAt_idx" ON "PaymentCancel"("status", "lastTriedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCancel_paymentId_idempotencyKey_key" ON "PaymentCancel"("paymentId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentCancel" ADD CONSTRAINT "PaymentCancel_sellerId_paymentId_fkey" FOREIGN KEY ("sellerId", "paymentId") REFERENCES "Payment"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 같은 주문에 승인 중·결제 완료·취소된 결제는 하나만(두 번 승인 금지). 결제 창만 연 READY·실패한 FAILED는 여러 개 가능.
CREATE UNIQUE INDEX "Payment_orderId_settled_key" ON "Payment"("orderId") WHERE "status" IN ('APPROVING', 'PAID', 'CANCELLED', 'PARTIAL_CANCELLED');

-- 금액 검사
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check" CHECK ("amount" > 0 AND "cancelledAmount" >= 0 AND "cancelledAmount" <= "amount");
ALTER TABLE "PaymentCancel" ADD CONSTRAINT "PaymentCancel_amount_check" CHECK ("amount" > 0);
