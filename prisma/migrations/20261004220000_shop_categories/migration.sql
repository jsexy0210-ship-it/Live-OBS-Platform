-- 쇼핑몰 카테고리(SA-015, 2026-10-04 대표님 지시). 2단까지, 값 범위는 lib/server/shop-category/service.ts. 부모·상품 연결은 (sellerId, id) 복합 키로 잇는다(판매자 격리).
-- CreateTable
CREATE TABLE "ShopCategory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "sellerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("productId","categoryId")
);

-- CreateIndex
CREATE INDEX "ShopCategory_sellerId_parentId_sortOrder_idx" ON "ShopCategory"("sellerId", "parentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ShopCategory_sellerId_id_key" ON "ShopCategory"("sellerId", "id");

-- CreateIndex
CREATE INDEX "ProductCategory_sellerId_categoryId_idx" ON "ProductCategory"("sellerId", "categoryId");

-- AddForeignKey
ALTER TABLE "ShopCategory" ADD CONSTRAINT "ShopCategory_sellerId_parentId_fkey" FOREIGN KEY ("sellerId", "parentId") REFERENCES "ShopCategory"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_sellerId_categoryId_fkey" FOREIGN KEY ("sellerId", "categoryId") REFERENCES "ShopCategory"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 자기 자신을 부모로 둘 수 없다
ALTER TABLE "ShopCategory" ADD CONSTRAINT "ShopCategory_parent_not_self" CHECK ("parentId" IS NULL OR "parentId" <> "id");
