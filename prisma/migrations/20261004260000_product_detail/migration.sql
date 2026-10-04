-- 상품 상세 페이지(PR-B, 2026-10-04 대표님 지시): 글·사진 블록 목록과 상세용 사진 구분(kind). 값 범위는 lib/server/products/detail.ts.
-- CreateEnum
CREATE TYPE "ProductImageKind" AS ENUM ('GALLERY', 'DETAIL');

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "kind" "ProductImageKind" NOT NULL DEFAULT 'GALLERY';

-- CreateTable
CREATE TABLE "ProductDetail" (
    "productId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "blocks" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductDetail_pkey" PRIMARY KEY ("productId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductDetail_sellerId_productId_key" ON "ProductDetail"("sellerId", "productId");

-- AddForeignKey
ALTER TABLE "ProductDetail" ADD CONSTRAINT "ProductDetail_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 블록은 배열, 최대 30개(HTML은 저장하지 않는다. 모양 검사는 서버 코드)
ALTER TABLE "ProductDetail" ADD CONSTRAINT "ProductDetail_blocks_check" CHECK (jsonb_typeof("blocks") = 'array' AND jsonb_array_length("blocks") <= 30);
