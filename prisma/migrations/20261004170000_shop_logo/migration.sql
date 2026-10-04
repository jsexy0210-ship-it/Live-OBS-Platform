-- 쇼핑몰 로고(SA-060, 2026-10-04 대표님 지시). 이미지는 A안(DB bytea).
-- CreateTable
CREATE TABLE "SellerLogo" (
    "sellerId" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerLogo_pkey" PRIMARY KEY ("sellerId")
);

-- AddForeignKey
ALTER TABLE "SellerLogo" ADD CONSTRAINT "SellerLogo_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 로고: 바이트로 확인한 PNG만, 2MB 이하, 정사각형 512~1440px(lib/server/shop-content/logo.ts와 같은 값)
ALTER TABLE "SellerLogo" ADD CONSTRAINT "SellerLogo_type_check" CHECK ("contentType" = 'image/png');
ALTER TABLE "SellerLogo" ADD CONSTRAINT "SellerLogo_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 2097152 AND octet_length("data") = "byteSize");
ALTER TABLE "SellerLogo" ADD CONSTRAINT "SellerLogo_dimension_check" CHECK ("width" = "height" AND "width" BETWEEN 512 AND 1440);
ALTER TABLE "SellerLogo" ADD CONSTRAINT "SellerLogo_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
