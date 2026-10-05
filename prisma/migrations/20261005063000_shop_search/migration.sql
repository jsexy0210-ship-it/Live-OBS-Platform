-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "searchTags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ShopSearchSynonym" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "words" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopSearchSynonym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSearchTerm" (
    "sellerId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "term" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ShopSearchTerm_pkey" PRIMARY KEY ("sellerId","day","term")
);

-- CreateIndex
CREATE INDEX "ShopSearchSynonym_sellerId_idx" ON "ShopSearchSynonym"("sellerId");


-- 유사어 묶음은 2~10단어, 검색어는 1~20자·횟수 1 이상
ALTER TABLE "ShopSearchSynonym" ADD CONSTRAINT "ShopSearchSynonym_words_check" CHECK (cardinality("words") BETWEEN 2 AND 10);
ALTER TABLE "ShopSearchTerm" ADD CONSTRAINT "ShopSearchTerm_term_check" CHECK (char_length("term") BETWEEN 1 AND 20 AND "count" >= 1);
-- 상품 검색 태그는 최대 10개
ALTER TABLE "Product" ADD CONSTRAINT "Product_searchTags_check" CHECK (cardinality("searchTags") <= 10);
