-- CreateEnum
CREATE TYPE "SubscriptionRefundSource" AS ENUM ('SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "SubscriptionRefundStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'REFUNDED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "SubscriptionRefund" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" "SubscriptionRefundSource" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "SubscriptionRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedByAdminId" UUID,
    "decidedByAdminId" UUID,
    "decisionNote" TEXT,
    "providerRefundId" TEXT,
    "failureReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),
    "refundedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SubscriptionRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionRefund_status_createdAt_idx" ON "SubscriptionRefund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionRefund_sellerId_createdAt_idx" ON "SubscriptionRefund"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscriptionRefund" ADD CONSTRAINT "SubscriptionRefund_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionRefund" ADD CONSTRAINT "SubscriptionRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SubscriptionPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 결제당 진행 중이거나 끝난 환불은 하나만(반려·실패는 남겨 두고 새로 요청할 수 있음)
CREATE UNIQUE INDEX "SubscriptionRefund_payment_active_key" ON "SubscriptionRefund"("paymentId") WHERE "status" IN ('REQUESTED', 'PROCESSING', 'REFUNDED');
ALTER TABLE "SubscriptionRefund" ADD CONSTRAINT "SubscriptionRefund_amount_positive" CHECK ("amount" > 0);

-- 이미 로그 추적에만 남아 있던 환불 대상(해지 뒤 확정된 결제)을 요청으로 옮긴다
INSERT INTO "SubscriptionRefund" ("sellerId", "paymentId", "amount", "source", "reason", "createdAt")
SELECT DISTINCT ON (p."id") p."sellerId", p."id", p."amount", 'SYSTEM', 'paid_after_cancel', a."createdAt"
FROM "AuditLog" a JOIN "SubscriptionPayment" p ON p."id"::text = a."targetId"
WHERE a."action" = 'subscription.refund_required' AND a."targetType" = 'SubscriptionPayment' AND p."status" = 'PAID' AND p."amount" > 0
ORDER BY p."id", a."createdAt"
ON CONFLICT DO NOTHING;
