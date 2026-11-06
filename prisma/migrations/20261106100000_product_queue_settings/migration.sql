-- SA-012 방송 설정 구역: 상품별 방송 주문대기 대상 여부와 오픈 타이머. 기존 상품은 모두 대상(true)·기본 타이머(null)로 그대로 둔다.
ALTER TABLE "Product" ADD COLUMN "queueEligible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Product" ADD COLUMN "openTimerSeconds" INTEGER;
ALTER TABLE "Product" ADD CONSTRAINT "Product_openTimerSeconds_check" CHECK ("openTimerSeconds" IS NULL OR "openTimerSeconds" IN (90, 120));
