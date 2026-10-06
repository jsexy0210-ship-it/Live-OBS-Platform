-- 첫 유효 런칭가 결제 성공 시각을 복구한다. 이미 기록된 시각은 보존하며
-- 실패/대기, STANDARD/스냅숏 청구, 해지 뒤 확정돼 환불 대상이 된 청구는 세지 않는다.
UPDATE "Seller" seller
   SET "launchDiscountUsedAt" = first_paid."paidAt"
  FROM (SELECT p."sellerId", min(p."paidAt") AS "paidAt"
          FROM "SubscriptionPayment" p
         WHERE p."launchDiscount" AND p."status" = 'PAID' AND p."paidAt" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."action" = 'subscription.refund_required' AND a."targetId" = p."id"::text)
         GROUP BY p."sellerId") first_paid
 WHERE seller."id" = first_paid."sellerId" AND seller."launchDiscountUsedAt" IS NULL;

-- 과거 해지/재가입 때 고정한 정가 플래그도 계정의 남은 할인 기간에 맞춘다.
-- 현재 청구 판정은 이 스냅숏이 아닌 계정 시각을 사용하므로 이후 만료에도 별도 작업이 필요 없다.
UPDATE "SellerSubscription" sub
   SET "regularPrice" = seller."launchDiscountUsedAt" IS NOT NULL AND now() >=
       ((seller."launchDiscountUsedAt" AT TIME ZONE 'Asia/Seoul') + INTERVAL '3 months') AT TIME ZONE 'Asia/Seoul'
  FROM "Seller" seller, "SubscriptionPlan" plan
 WHERE sub."sellerId" = seller."id" AND sub."planId" = plan."id" AND plan."code" IN ('OVERLAY_ONLY', 'INTEGRATED');
