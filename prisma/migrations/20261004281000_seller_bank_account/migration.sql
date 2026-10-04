-- 무통장 입금 계좌(기반-결제 2단계)

-- CreateTable
CREATE TABLE "SellerBankAccount" (
    "sellerId" UUID NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerBankAccount_pkey" PRIMARY KEY ("sellerId")
);

-- AddForeignKey
ALTER TABLE "SellerBankAccount" ADD CONSTRAINT "SellerBankAccount_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

