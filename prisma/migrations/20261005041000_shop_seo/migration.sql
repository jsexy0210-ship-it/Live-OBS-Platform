-- 쇼핑몰 검색 노출 설정(SA-067)

-- CreateTable
CREATE TABLE "ShopSeo" (
    "sellerId" UUID NOT NULL,
    "searchTitle" TEXT,
    "searchDescription" TEXT,
    "indexingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sitemapEnabled" BOOLEAN NOT NULL DEFAULT true,
    "productTitleTemplate" TEXT,
    "productDescriptionTemplate" TEXT,
    "googleVerification" TEXT,
    "naverVerification" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopSeo_pkey" PRIMARY KEY ("sellerId")
);

-- AddForeignKey
ALTER TABLE "ShopSeo" ADD CONSTRAINT "ShopSeo_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
