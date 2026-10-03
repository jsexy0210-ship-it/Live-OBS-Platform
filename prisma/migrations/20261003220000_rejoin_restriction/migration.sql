-- 재가입 제한(판매자 설정)과 제한용 CI 해시 보관
CREATE TABLE "SellerMemberPolicy" (
    "sellerId" UUID NOT NULL,
    "rejoinRestrictionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rejoinRestrictionDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerMemberPolicy_pkey" PRIMARY KEY ("sellerId"),
    CONSTRAINT "SellerMemberPolicy_rejoinRestrictionDays_check" CHECK ("rejoinRestrictionDays" BETWEEN 1 AND 365)
);

CREATE TABLE "BuyerRejoinBlock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "ciHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerRejoinBlock_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BuyerRejoinBlock_ciHash_check" CHECK ("ciHash" <> '')
);

CREATE UNIQUE INDEX "BuyerRejoinBlock_sellerId_ciHash_key" ON "BuyerRejoinBlock"("sellerId", "ciHash");
CREATE INDEX "BuyerRejoinBlock_expiresAt_idx" ON "BuyerRejoinBlock"("expiresAt");

ALTER TABLE "SellerMemberPolicy" ADD CONSTRAINT "SellerMemberPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BuyerRejoinBlock" ADD CONSTRAINT "BuyerRejoinBlock_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
