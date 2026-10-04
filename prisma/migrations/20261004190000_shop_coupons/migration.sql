-- 쿠폰(SA-035 쿠폰 관리 · SH-028 내 쿠폰함, 2026-10-04 대표님 지시). 값 범위는 lib/server/shop-coupons/rules.ts와 같다.
-- CreateEnum
CREATE TYPE "CouponBenefit" AS ENUM ('AMOUNT', 'RATE', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "CouponIssueMethod" AS ENUM ('DOWNLOAD', 'CODE', 'MANUAL');

-- CreateEnum
CREATE TYPE "BuyerCouponStatus" AS ENUM ('ISSUED', 'USED');

-- CreateTable
CREATE TABLE "Coupon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "issueMethod" "CouponIssueMethod" NOT NULL,
    "code" TEXT,
    "benefit" "CouponBenefit" NOT NULL,
    "value" INTEGER,
    "maxDiscount" INTEGER,
    "minOrderAmount" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "validDays" INTEGER,
    "issueLimit" INTEGER,
    "issuedCount" INTEGER NOT NULL DEFAULT 0,
    "productIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "excludeDiscounted" BOOLEAN NOT NULL DEFAULT true,
    "allowWithReward" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerCoupon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "status" "BuyerCouponStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BuyerCoupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "buyerCouponId" UUID NOT NULL,
    "benefit" "CouponBenefit" NOT NULL,
    "discountAmount" INTEGER NOT NULL,
    "itemDiscounts" JSONB NOT NULL DEFAULT '{}',
    "restoredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Coupon_sellerId_createdAt_idx" ON "Coupon"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_sellerId_id_key" ON "Coupon"("sellerId", "id");

-- CreateIndex
CREATE INDEX "BuyerCoupon_sellerId_buyerMemberId_status_idx" ON "BuyerCoupon"("sellerId", "buyerMemberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerCoupon_couponId_buyerMemberId_key" ON "BuyerCoupon"("couponId", "buyerMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerCoupon_sellerId_id_key" ON "BuyerCoupon"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "CouponRedemption"("orderId");

-- CreateIndex
CREATE INDEX "CouponRedemption_sellerId_couponId_idx" ON "CouponRedemption"("sellerId", "couponId");

-- CreateIndex
CREATE INDEX "CouponRedemption_sellerId_buyerCouponId_idx" ON "CouponRedemption"("sellerId", "buyerCouponId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_sellerId_orderId_key" ON "CouponRedemption"("sellerId", "orderId");

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerCoupon" ADD CONSTRAINT "BuyerCoupon_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerCoupon" ADD CONSTRAINT "BuyerCoupon_sellerId_couponId_fkey" FOREIGN KEY ("sellerId", "couponId") REFERENCES "Coupon"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerCoupon" ADD CONSTRAINT "BuyerCoupon_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_sellerId_couponId_fkey" FOREIGN KEY ("sellerId", "couponId") REFERENCES "Coupon"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_sellerId_buyerCouponId_fkey" FOREIGN KEY ("sellerId", "buyerCouponId") REFERENCES "BuyerCoupon"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 쿠폰 이름 1~30자(구매자 쿠폰함에 그대로 보임)
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_name_check" CHECK (char_length("name") BETWEEN 1 AND 30);
-- 코드 입력 방식만 코드가 있다(대문자 영문·숫자 4~16자). 쇼핑몰 안에서 겹치지 않는다.
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_code_check" CHECK (("issueMethod" = 'CODE') = ("code" IS NOT NULL) AND ("code" IS NULL OR "code" ~ '^[A-Z0-9]{4,16}$'));
CREATE UNIQUE INDEX "Coupon_seller_code_key" ON "Coupon"("sellerId", "code") WHERE "code" IS NOT NULL;
-- 혜택별 값: 금액 할인 1원~1천만 원, 비율 할인 1~90 %(최대 할인 금액은 선택), 배송비 무료는 값 없음
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_benefit_check" CHECK (
  ("benefit" = 'AMOUNT' AND "value" BETWEEN 1 AND 10000000 AND "maxDiscount" IS NULL)
  OR ("benefit" = 'RATE' AND "value" BETWEEN 1 AND 90 AND ("maxDiscount" IS NULL OR "maxDiscount" BETWEEN 1 AND 10000000))
  OR ("benefit" = 'FREE_SHIPPING' AND "value" IS NULL AND "maxDiscount" IS NULL)
);
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_min_order_check" CHECK ("minOrderAmount" BETWEEN 0 AND 100000000);
-- 기간: 시작 < 종료, 받은 날부터 쓸 수 있는 날 수는 1~365일
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_period_check" CHECK ("startsAt" < "endsAt" AND ("validDays" IS NULL OR "validDays" BETWEEN 1 AND 365));
-- 발급 수: 한도가 있으면 넘지 않는다(조건부 UPDATE와 함께 DB에서도 막음)
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_issue_check" CHECK ("issuedCount" >= 0 AND ("issueLimit" IS NULL OR ("issueLimit" BETWEEN 1 AND 1000000 AND "issuedCount" <= "issueLimit")));
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_products_check" CHECK ("productIds" IS NOT NULL AND cardinality("productIds") <= 100);
-- 받은 쿠폰: 쓴 쿠폰만 사용 시각이 있다. 만료는 받은 뒤.
ALTER TABLE "BuyerCoupon" ADD CONSTRAINT "BuyerCoupon_used_check" CHECK (("status" = 'USED') = ("usedAt" IS NOT NULL));
ALTER TABLE "BuyerCoupon" ADD CONSTRAINT "BuyerCoupon_period_check" CHECK ("issuedAt" < "expiresAt");
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_amount_check" CHECK ("discountAmount" >= 0);
