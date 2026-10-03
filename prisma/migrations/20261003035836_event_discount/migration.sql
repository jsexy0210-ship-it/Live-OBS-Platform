-- CreateEnum
CREATE TYPE "EventDiscountType" AS ENUM ('RATE', 'AMOUNT');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "listUnitPrice" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "eventDiscountType" "EventDiscountType",
ADD COLUMN     "eventDiscountValue" INTEGER,
ADD COLUMN     "eventEndsAt" TIMESTAMPTZ(3),
ADD COLUMN     "eventStartsAt" TIMESTAMPTZ(3);

-- 이벤트 할인은 넷 다 있거나 넷 다 없다. 할인율은 1~90%, 할인 금액은 1원 이상, 종료는 시작보다 뒤
ALTER TABLE "Product" ADD CONSTRAINT "Product_event_discount_check" CHECK (
  ("eventDiscountType" IS NULL AND "eventDiscountValue" IS NULL AND "eventStartsAt" IS NULL AND "eventEndsAt" IS NULL)
  OR ("eventDiscountType" IS NOT NULL AND "eventDiscountValue" IS NOT NULL AND "eventStartsAt" IS NOT NULL AND "eventEndsAt" IS NOT NULL
      AND "eventEndsAt" > "eventStartsAt"
      AND (("eventDiscountType" = 'RATE' AND "eventDiscountValue" BETWEEN 1 AND 90) OR ("eventDiscountType" = 'AMOUNT' AND "eventDiscountValue" >= 1)))
);
