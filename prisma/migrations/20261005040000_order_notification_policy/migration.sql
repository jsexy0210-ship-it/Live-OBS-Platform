-- 주문자 메일 켜기·끄기(SA-080)

-- CreateTable
CREATE TABLE "SellerOrderNotificationPolicy" (
    "sellerId" UUID NOT NULL,
    "orderCompleteEnabled" BOOLEAN NOT NULL DEFAULT true,
    "shippedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "deliveredEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cancelRefundEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerOrderNotificationPolicy_pkey" PRIMARY KEY ("sellerId")
);

-- AddForeignKey
ALTER TABLE "SellerOrderNotificationPolicy" ADD CONSTRAINT "SellerOrderNotificationPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
