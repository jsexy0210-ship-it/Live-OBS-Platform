-- SA-005 쇼핑몰 통합 전환: 사업자·정산 정보(계좌번호는 암호문+뒤 4자리만)
CREATE TABLE "SellerIntegrationProfile" (
  "sellerId" UUID NOT NULL,
  "companyName" TEXT,
  "representativeName" TEXT,
  "businessNumber" TEXT,
  "mailOrderNumber" TEXT,
  "businessAddress" TEXT,
  "bankName" TEXT,
  "accountCipher" TEXT,
  "accountLast4" TEXT,
  "accountHolder" TEXT,
  "checkBusinessNumber" TEXT,
  "checkRepresentativeName" TEXT,
  "checkStatus" TEXT,
  "checkValid" BOOLEAN,
  "checkedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerIntegrationProfile_pkey" PRIMARY KEY ("sellerId"),
  CONSTRAINT "SellerIntegrationProfile_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SellerIntegrationProfile_check_status" CHECK ("checkStatus" IS NULL OR "checkStatus" IN ('ACTIVE', 'SUSPENDED', 'CLOSED', 'NOT_FOUND'))
);
