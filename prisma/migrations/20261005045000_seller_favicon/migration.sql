-- 쇼핑몰 파비콘 원본(SA-060)
CREATE TABLE "SellerFavicon" (
    "sellerId" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerFavicon_pkey" PRIMARY KEY ("sellerId"),
    CONSTRAINT "SellerFavicon_size_check" CHECK ("byteSize" BETWEEN 1 AND 262144 AND "width" BETWEEN 64 AND 1024)
);

ALTER TABLE "SellerFavicon" ADD CONSTRAINT "SellerFavicon_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
