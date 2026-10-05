-- 회원 등급 혜택: 배송비 혜택(없음·정액 할인·무료)과 승급 쿠폰
-- CreateEnum
CREATE TYPE "GradeShippingBenefit" AS ENUM ('NONE', 'DISCOUNT', 'FREE');

-- AlterTable
ALTER TABLE "MemberGrade" ADD COLUMN     "promotionCouponId" UUID,
ADD COLUMN     "shippingBenefit" "GradeShippingBenefit" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "shippingDiscount" INTEGER NOT NULL DEFAULT 0;

-- 정액 할인만 금액이 있고(1원 이상), 그 밖에는 0원
ALTER TABLE "MemberGrade" ADD CONSTRAINT "MemberGrade_shipping_benefit" CHECK (
  ("shippingBenefit" = 'DISCOUNT' AND "shippingDiscount" BETWEEN 1 AND 100000)
  OR ("shippingBenefit" <> 'DISCOUNT' AND "shippingDiscount" = 0)
);
