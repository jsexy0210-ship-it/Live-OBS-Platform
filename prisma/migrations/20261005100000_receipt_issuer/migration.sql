-- 현금영수증·전자세금계산서 파트너스 명의 발행자 정보(lib/server/receipts/issuer.ts)
CREATE TYPE "ReceiptCertStatus" AS ENUM ('NOT_REGISTERED', 'REGISTERED', 'EXPIRED');

CREATE TABLE "SellerReceiptIssuer" (
    "sellerId" UUID NOT NULL,
    "businessNumber" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "representative" TEXT NOT NULL,
    "certStatus" "ReceiptCertStatus" NOT NULL DEFAULT 'NOT_REGISTERED',
    "certCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerReceiptIssuer_pkey" PRIMARY KEY ("sellerId")
);

ALTER TABLE "SellerReceiptIssuer" ADD CONSTRAINT "SellerReceiptIssuer_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
