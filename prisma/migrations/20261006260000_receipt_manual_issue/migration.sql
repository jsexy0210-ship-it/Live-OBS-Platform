-- SA-024 직접 발행 후 완료 처리: 구매자 안내 기록 종류, 발행 방식 설정(lib/server/receipts/)
ALTER TYPE "OrderNotificationKind" ADD VALUE 'RECEIPT_ISSUED';

CREATE TYPE "ReceiptIssueMode" AS ENUM ('DIRECT', 'AUTO');

CREATE TABLE "SellerReceiptSetting" (
    "sellerId" UUID NOT NULL,
    "issueMode" "ReceiptIssueMode" NOT NULL DEFAULT 'DIRECT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerReceiptSetting_pkey" PRIMARY KEY ("sellerId")
);

ALTER TABLE "SellerReceiptSetting" ADD CONSTRAINT "SellerReceiptSetting_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
