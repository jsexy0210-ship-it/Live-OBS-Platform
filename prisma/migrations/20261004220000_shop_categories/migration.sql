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

-- 자동 상품 코드(MASTER 결정 2026-10-04): 판매자별 1부터 순번, 화면은 P + 7자리. 기존 상품은 등록 순(createdAt, id)으로 채운다.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "codeNo" INTEGER NOT NULL DEFAULT 0;

UPDATE "Product" p SET "codeNo" = n."no"
FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "sellerId" ORDER BY "createdAt", "id") AS "no" FROM "Product") n
WHERE p."id" = n."id";

-- CreateIndex
CREATE UNIQUE INDEX "Product_sellerId_codeNo_key" ON "Product"("sellerId", "codeNo");

-- 새 상품은 codeNo를 0(기본)으로 넣으면 판매자별 잠금 아래 다음 번호를 매긴다. 같은 문장에서 여러 행을 넣어도 앞 행 번호를 보고 이어 매긴다.
CREATE FUNCTION product_assign_code_no() RETURNS trigger AS $$
BEGIN
  IF NEW."codeNo" <= 0 THEN
    PERFORM pg_advisory_xact_lock(hashtext('product_code:' || NEW."sellerId"::text));
    SELECT COALESCE(MAX("codeNo"), 0) + 1 INTO NEW."codeNo" FROM "Product" WHERE "sellerId" = NEW."sellerId";
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Product_assign_code_no" BEFORE INSERT ON "Product" FOR EACH ROW EXECUTE FUNCTION product_assign_code_no();

-- 코드 번호는 바꾸지 않는다(0 이하로 두지 않음)
ALTER TABLE "Product" ADD CONSTRAINT "Product_codeNo_positive" CHECK ("codeNo" > 0);
