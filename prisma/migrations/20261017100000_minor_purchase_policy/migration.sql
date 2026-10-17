-- 미성년자 구매 정책(SH-009): 쇼핑몰별 「고지 후 허용(기본)」 / 「구매 막기」
CREATE TYPE "MinorPurchasePolicy" AS ENUM ('NOTICE', 'BLOCK');
ALTER TABLE "ShopLegalNotice" ADD COLUMN "minorPolicy" "MinorPurchasePolicy" NOT NULL DEFAULT 'NOTICE';
