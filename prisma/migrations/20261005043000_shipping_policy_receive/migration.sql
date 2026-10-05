-- SA-061 배송 정책: 받는 방법·발송 기한·기본 택배사
ALTER TABLE "SellerShippingPolicy" ADD COLUMN "receiveMethods" TEXT[] DEFAULT ARRAY['IMMEDIATE']::TEXT[],
ADD COLUMN "dispatchDeadlineDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "defaultCourier" TEXT;

ALTER TABLE "SellerShippingPolicy" ADD CONSTRAINT "SellerShippingPolicy_dispatchDeadlineDays_check" CHECK ("dispatchDeadlineDays" BETWEEN 1 AND 30);
