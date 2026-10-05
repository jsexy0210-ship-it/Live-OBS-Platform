-- 쇼핑몰 대표 색상(SA-060)
CREATE TABLE "SellerBrandColor" (
    "sellerId" UUID NOT NULL,
    "color" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerBrandColor_pkey" PRIMARY KEY ("sellerId"),
    CONSTRAINT "SellerBrandColor_color_check" CHECK ("color" ~ '^#[0-9A-F]{6}$')
);

ALTER TABLE "SellerBrandColor" ADD CONSTRAINT "SellerBrandColor_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
