-- 상품 진열 확장(SA-016, MASTER 배정 2026-10-05): 영역 종류 4개, 진열 옵션 3개, 카테고리 안 상품 순서. 값 범위는 lib/server/shop-display/service.ts.
-- AlterEnum


ALTER TYPE "ShopDisplayKind" ADD VALUE 'LIVE';
ALTER TYPE "ShopDisplayKind" ADD VALUE 'BEST';
ALTER TYPE "ShopDisplayKind" ADD VALUE 'SALE';
ALTER TYPE "ShopDisplayKind" ADD VALUE 'HALL_OF_FAME';

-- AlterTable
ALTER TABLE "ProductCategory" ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShopDisplaySetting" ADD COLUMN     "hideSoldOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liveFirst" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "soldOutLast" BOOLEAN NOT NULL DEFAULT false;


-- 지금까지 지정한 상품은 카테고리마다 지정한 순서(createdAt, productId)로 0부터 채운다
UPDATE "ProductCategory" pc SET "sortOrder" = n."no"
FROM (SELECT "productId", "categoryId", ROW_NUMBER() OVER (PARTITION BY "categoryId" ORDER BY "createdAt", "productId") - 1 AS "no" FROM "ProductCategory") n
WHERE pc."productId" = n."productId" AND pc."categoryId" = n."categoryId";
