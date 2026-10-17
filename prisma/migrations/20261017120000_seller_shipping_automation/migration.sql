-- 배송 자동화 기능별 켜기/끄기(SA-082). 행이 없으면 모두 꺼짐.
CREATE TABLE "SellerShippingAutomation" (
    "sellerId" UUID NOT NULL,
    "invoiceIssueEnabled" BOOLEAN NOT NULL DEFAULT false,
    "invoiceLabelEnabled" BOOLEAN NOT NULL DEFAULT false,
    "returnInvoiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerShippingAutomation_pkey" PRIMARY KEY ("sellerId")
);

ALTER TABLE "SellerShippingAutomation" ADD CONSTRAINT "SellerShippingAutomation_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
