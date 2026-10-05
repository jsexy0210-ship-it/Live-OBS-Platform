-- AlterTable
ALTER TABLE "ProductDetail" ADD COLUMN     "html" TEXT;

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "thumbnail" BOOLEAN NOT NULL DEFAULT false;


-- 썸네일은 상품 사진(GALLERY)에만, 상품마다 하나(지정이 없으면 첫 번째 사진이 썸네일)
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_thumbnail_gallery_check" CHECK (NOT "thumbnail" OR "kind" = 'GALLERY');
CREATE UNIQUE INDEX "ProductImage_one_thumbnail_per_product" ON "ProductImage"("productId") WHERE "thumbnail";
