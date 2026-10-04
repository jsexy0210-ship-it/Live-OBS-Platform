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

-- 런칭 할인 계정당 1회(대표님 결정 2026-10-04): 계정의 사용 시각, 구독의 정가 청구 여부, 청구의 런칭가 여부.
-- 이전 전 STANDARD·스냅숏 결제는 사용으로 세지 않는다. 새 플랜 뒤 이미 확정된 런칭가 결제는 아래 BACKFILL이 채운다.
ALTER TABLE "Seller" ADD COLUMN "launchDiscountUsedAt" TIMESTAMPTZ(3);
ALTER TABLE "SellerSubscription" ADD COLUMN "regularPrice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SubscriptionPayment" ADD COLUMN "launchDiscount" BOOLEAN NOT NULL DEFAULT false;

-- BACKFILL(아래 두 UPDATE는 tests/integration/planMigration.test.ts가 적용 전 상태에 그대로 다시 돌려 확인한다)
-- 새 플랜(#185, 20261004150000) 뒤 이 마이그레이션 전에 만든 청구도 chargeFor와 같은 조건으로 런칭가 여부를 정한다(#186 Codex).
--   새 플랜 행이 생긴 뒤(이전 전 STANDARD 결제 제외)에 만든 청구이고, STANDARD 플랜 구독이 아니다.
--   이전 전 가격 스냅숏 청구가 아니다(스냅숏이 있고 고지가 없거나 고지 + 30일 전에 만든 청구는 뺀다).
--   이전된 구독(새 플랜 전에 만든 구독 행)은 재구독(subscribedAt) 뒤 청구만 센다. 재구독이 스냅숏을 비우므로 그 전 청구는 스냅숏·STANDARD 청구다.
-- 진행 중(PENDING) 청구도 표시해 두어 이 마이그레이션 뒤에 확정되면 settlePayment가 사용을 남긴다.
UPDATE "SubscriptionPayment" p
   SET "launchDiscount" = true
  FROM "SellerSubscription" s, "SubscriptionPlan" pl, (SELECT "createdAt" AS "at" FROM "SubscriptionPlan" WHERE "code" = 'INTEGRATED') cut
 WHERE s."id" = p."subscriptionId" AND pl."id" = s."planId"
   AND pl."code" <> 'STANDARD'
   AND p."createdAt" >= cut."at"
   AND (s."createdAt" >= cut."at" OR p."createdAt" >= s."subscribedAt")
   AND NOT (s."legacyPrice" IS NOT NULL
            AND (s."legacyPriceNoticeSentAt" IS NULL OR p."createdAt" < s."legacyPriceNoticeSentAt" + INTERVAL '30 days'));
-- 이미 확정된 런칭가 청구가 있는 판매자는 첫 확정 시각을 사용으로 남긴다. 해지 뒤 확정돼 환불 대상으로 남긴 청구(subscription.refund_required)는 세지 않는다.
UPDATE "Seller" sl
   SET "launchDiscountUsedAt" = f."firstPaidAt"
  FROM (SELECT p."sellerId", MIN(COALESCE(p."paidAt", p."createdAt")) AS "firstPaidAt"
          FROM "SubscriptionPayment" p
         WHERE p."launchDiscount" AND p."status" = 'PAID'
           AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."action" = 'subscription.refund_required' AND a."targetId" = p."id"::text)
         GROUP BY p."sellerId") f
 WHERE sl."id" = f."sellerId" AND sl."launchDiscountUsedAt" IS NULL;
