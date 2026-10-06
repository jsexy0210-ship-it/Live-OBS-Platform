-- 파트너스 가입 신청 사업자등록증 파일(PF-007-4). 신청 전에는 본인확인 기록에, 신청 뒤에는 쇼핑몰에 묶인다.
CREATE TABLE "SellerBusinessLicense" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "verificationId" UUID,
    "sellerId" UUID,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerBusinessLicense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SellerBusinessLicense_owner_check" CHECK ("verificationId" IS NOT NULL OR "sellerId" IS NOT NULL),
    CONSTRAINT "SellerBusinessLicense_byteSize_check" CHECK ("byteSize" > 0 AND "byteSize" <= 10485760)
);
CREATE UNIQUE INDEX "SellerBusinessLicense_verificationId_key" ON "SellerBusinessLicense"("verificationId");
CREATE UNIQUE INDEX "SellerBusinessLicense_sellerId_key" ON "SellerBusinessLicense"("sellerId");
ALTER TABLE "SellerBusinessLicense" ADD CONSTRAINT "SellerBusinessLicense_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;
