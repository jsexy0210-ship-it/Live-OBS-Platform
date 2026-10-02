-- CreateEnum
CREATE TYPE "SellerSubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "serviceEndedAt" TIMESTAMPTZ(3),
ADD COLUMN     "trialEndsAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "SellerDomain" ADD COLUMN     "suspendedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "listPrice" INTEGER NOT NULL,
    "salePrice" INTEGER NOT NULL,
    "previousSalePrice" INTEGER,
    "priceChangedAt" TIMESTAMPTZ(3),
    "trialMessageLimit" INTEGER NOT NULL DEFAULT 100,
    "trialIdentityLimit" INTEGER NOT NULL DEFAULT 50,
    "trialStorageMb" INTEGER NOT NULL DEFAULT 1024,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerSubscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SellerSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "billingKeyCipher" TEXT,
    "cardLabel" TEXT,
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "nextChargeAt" TIMESTAMPTZ(3),
    "billingAnchorAt" TIMESTAMPTZ(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "graceUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "providerPaymentId" TEXT,
    "receiptUrl" TEXT,
    "failureReason" TEXT,
    "scheduled" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SellerSubscription_sellerId_key" ON "SellerSubscription"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerSubscription_sellerId_id_key" ON "SellerSubscription"("sellerId", "id");

-- CreateIndex
CREATE INDEX "SellerSubscription_status_nextChargeAt_idx" ON "SellerSubscription"("status", "nextChargeAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_sellerId_createdAt_idx" ON "SubscriptionPayment"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_sellerId_subscriptionId_fkey" FOREIGN KEY ("sellerId", "subscriptionId") REFERENCES "SellerSubscription"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 손으로 추가: 가격·금액·기간 검사
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_price_check" CHECK ("salePrice" > 0 AND "listPrice" >= "salePrice");
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_trial_limit_check" CHECK ("trialMessageLimit" >= 0 AND "trialIdentityLimit" >= 0 AND "trialStorageMb" >= 0);
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_amount_check" CHECK ("amount" > 0);
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_period_check" CHECK ("periodEnd" > "periodStart");
ALTER TABLE "SellerSubscription" ADD CONSTRAINT "SellerSubscription_retry_check" CHECK ("retryCount" >= 0 AND "retryCount" <= 3);

-- 같은 구독·같은 이용 기간에는 진행 중이거나 결제된 청구가 하나만(중복 결제 방지). 실패한 청구는 다시 시도할 수 있다.
CREATE UNIQUE INDEX "SubscriptionPayment_active_period_key" ON "SubscriptionPayment"("subscriptionId", "periodStart") WHERE "status" IN ('PENDING', 'PAID');
-- 구독당 진행 중(PENDING) 청구는 하나만. 카드 등록과 예약 결제가 기간 시작을 다르게 잡아도 동시에 결제하지 못한다.
CREATE UNIQUE INDEX "SubscriptionPayment_one_pending_key" ON "SubscriptionPayment"("subscriptionId") WHERE "status" = 'PENDING';

-- 기본 요금제(대표님 결정 2026-10-02): 정가 300,000원, 판매가 199,000원, 부가세 포함. 이후 변경은 마스터가 한다.
INSERT INTO "SubscriptionPlan" ("code", "name", "listPrice", "salePrice", "updatedAt")
VALUES ('STANDARD', '월 구독', 300000, 199000, CURRENT_TIMESTAMP);

-- 이미 승인된 쇼핑몰은 승인 시각(없으면 지금) + 3일을 체험하기 종료로 채운다.
UPDATE "Seller" SET "trialEndsAt" = COALESCE("approvedAt", CURRENT_TIMESTAMP) + interval '3 days' WHERE "status" = 'ACTIVE' AND "trialEndsAt" IS NULL;
