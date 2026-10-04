-- 상품 사진 업로드(PR-A, 2026-10-04 대표님 지시)와 공통 이미지 저장소 DB 드라이버(IMAGE_STORAGE=db, 대표님 결정 2026-10-04).
-- 값 범위는 lib/server/products/images.ts·lib/server/storage/db.ts와 같다. ProductImage는 지금까지 쓰는 코드가 없어 비어 있다(행이 있으면 NOT NULL 추가가 실패해 알 수 있다).
-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "byteSize" INTEGER NOT NULL,
ADD COLUMN     "contentType" TEXT NOT NULL,
ADD COLUMN     "height" INTEGER NOT NULL,
ADD COLUMN     "sha256" TEXT NOT NULL,
ADD COLUMN     "width" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "StoredImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoredImage_sellerId_idx" ON "StoredImage"("sellerId");


-- 형식·크기·해시. 저장소는 PNG·JPEG·WEBP를 받을 수 있게 두고, 어떤 형식을 받을지는 각 업로드 경로가 정한다.
ALTER TABLE "StoredImage" ADD CONSTRAINT "StoredImage_type_check" CHECK ("contentType" IN ('image/png', 'image/jpeg', 'image/webp'));
ALTER TABLE "StoredImage" ADD CONSTRAINT "StoredImage_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 5242880 AND octet_length("data") = "byteSize");
ALTER TABLE "StoredImage" ADD CONSTRAINT "StoredImage_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_type_check" CHECK ("contentType" IN ('image/png', 'image/jpeg', 'image/webp'));
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 5242880 AND "width" > 0 AND "height" > 0);
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX "ProductImage_storageKey_key" ON "ProductImage"("storageKey");
