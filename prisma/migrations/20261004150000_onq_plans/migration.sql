-- ONQ 1-C-1: 플랜 2종(오버레이 전용·쇼핑몰 통합), 플랜별 체험 일수, 판매자 플랜, 기존 STANDARD 이전(결정적 백필, ARCHITECTURE 4.8.0)

ALTER TABLE "SubscriptionPlan" ADD COLUMN "trialDays" INTEGER NOT NULL DEFAULT 0;
-- 이전 전 플랜의 체험(14일). 이전 뒤 신규 가입에는 쓰지 않는다.
UPDATE "SubscriptionPlan" SET "trialDays" = 14 WHERE "code" = 'STANDARD';

INSERT INTO "SubscriptionPlan" ("code", "name", "listPrice", "salePrice", "trialDays", "updatedAt")
VALUES ('OVERLAY_ONLY', '오버레이 전용', 99000, 69000, 7, CURRENT_TIMESTAMP),
       ('INTEGRATED', '쇼핑몰 통합', 249000, 179000, 0, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

ALTER TABLE "Seller" ADD COLUMN "planId" UUID;
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SellerSubscription" ADD COLUMN "legacyPrice" INTEGER, ADD COLUMN "legacyPriceNoticeSentAt" TIMESTAMPTZ(3);

-- BACKFILL(아래 세 UPDATE는 tests/integration/planMigration.test.ts가 이전 전 상태에 그대로 다시 돌려 확인한다)
-- 이전 전 가격 스냅숏: 결제가 이어지는 STANDARD 구독(체험 중·결제 중·유예 중·해지 예약)만. 해지(CANCELED)됐거나 해지 예약 기간이 이미
-- 끝난 구독은 남기지 않는다(다시 구독하면 새 가입자 가격). 금액은 priceFor와 같은 규칙(구독 시작 때 적용되던 가격, 또는 변경 + 30일이 지난 가격 중 최근).
UPDATE "SellerSubscription" s
   SET "legacyPrice" = COALESCE(
         (SELECT c."salePrice" FROM "SubscriptionPriceChange" c
           WHERE c."planId" = s."planId" AND (c."changedAt" <= s."subscribedAt" OR c."changedAt" <= now() - INTERVAL '30 days')
           ORDER BY c."changedAt" DESC LIMIT 1),
         p."salePrice")
  FROM "SubscriptionPlan" p
 WHERE p."id" = s."planId" AND p."code" = 'STANDARD'
   AND s."status" IN ('ACTIVE', 'PAST_DUE')
   AND NOT (s."cancelAtPeriodEnd" AND s."currentPeriodEnd" IS NOT NULL AND s."currentPeriodEnd" <= now());

-- 모든 STANDARD 구독(해지 보관 포함)을 통합으로. 상태·체험 종료일·결제일·유예·재시도·해지 예약은 그대로 둔다.
UPDATE "SellerSubscription"
   SET "planId" = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'INTEGRATED')
 WHERE "planId" = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'STANDARD');

-- 모든 기존 판매자(구독 행 없는 체험 중·잠김 포함)를 통합으로. trialEndsAt은 그대로 둔다.
UPDATE "Seller" SET "planId" = (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = 'INTEGRATED') WHERE "planId" IS NULL;
