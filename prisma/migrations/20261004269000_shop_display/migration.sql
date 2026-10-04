-- 상품 진열(SA-016, 2026-10-04 대표님 지시): 목록 기본 정렬, 홈 진열 영역, 추천 상품. 값 범위는 lib/server/shop-display/service.ts.
-- CreateEnum
CREATE TYPE "ShopDisplayKind" AS ENUM ('RECOMMENDED', 'NEW', 'CATEGORY');

-- CreateTable
CREATE TABLE "ShopDisplaySetting" (
    "sellerId" UUID NOT NULL,
    "listSort" TEXT NOT NULL DEFAULT 'new',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopDisplaySetting_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "ShopDisplaySection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "kind" "ShopDisplayKind" NOT NULL,
    "categoryId" UUID,
    "title" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "itemCount" INTEGER NOT NULL DEFAULT 8,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShopDisplaySection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopDisplayItem" (
    "sellerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "ShopDisplayItem_pkey" PRIMARY KEY ("sellerId","productId")
);

-- CreateIndex
CREATE INDEX "ShopDisplaySection_sellerId_sortOrder_idx" ON "ShopDisplaySection"("sellerId", "sortOrder");

-- CreateIndex
CREATE INDEX "ShopDisplayItem_sellerId_sortOrder_idx" ON "ShopDisplayItem"("sellerId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ShopDisplaySection" ADD CONSTRAINT "ShopDisplaySection_sellerId_categoryId_fkey" FOREIGN KEY ("sellerId", "categoryId") REFERENCES "ShopCategory"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopDisplayItem" ADD CONSTRAINT "ShopDisplayItem_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ShopDisplaySetting" ADD CONSTRAINT "ShopDisplaySetting_listSort_check" CHECK ("listSort" IN ('new', 'recommended', 'popular', 'low', 'high'));
ALTER TABLE "ShopDisplaySection" ADD CONSTRAINT "ShopDisplaySection_itemCount_check" CHECK ("itemCount" BETWEEN 1 AND 20);
-- 카테고리 영역만 카테고리를 가리킨다
ALTER TABLE "ShopDisplaySection" ADD CONSTRAINT "ShopDisplaySection_category_check" CHECK (("kind" = 'CATEGORY') = ("categoryId" IS NOT NULL));
-- 추천·신상품 영역은 쇼핑몰마다 하나
CREATE UNIQUE INDEX "ShopDisplaySection_single_kind_key" ON "ShopDisplaySection"("sellerId", "kind") WHERE "kind" <> 'CATEGORY';
