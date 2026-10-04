-- ONQ 1-C-2: 상위 변경(차액 즉시)·하위 변경(다음 결제일)

CREATE TYPE "SubscriptionPaymentKind" AS ENUM ('PERIOD', 'PRORATION');

ALTER TABLE "SubscriptionPayment" ADD COLUMN "kind" "SubscriptionPaymentKind" NOT NULL DEFAULT 'PERIOD',
  ADD COLUMN "targetPlanId" UUID;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_targetPlanId_fkey" FOREIGN KEY ("targetPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SellerSubscription" ADD COLUMN "pendingPlanId" UUID;
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 같은 구독·같은 이용 기간의 진행 중·결제된 청구는 하나(기간 결제만). 차액 청구는 기간을 바꾸지 않아 이 제한에서 뺀다.
-- 구독당 진행 중(PENDING) 청구 하나(SubscriptionPayment_one_pending_key)는 그대로 모든 종류에 적용한다.
DROP INDEX "SubscriptionPayment_active_period_key";
CREATE UNIQUE INDEX "SubscriptionPayment_active_period_key" ON "SubscriptionPayment"("subscriptionId", "periodStart") WHERE "status" IN ('PENDING', 'PAID') AND "kind" = 'PERIOD';
