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

-- 가입 때 안내받은 재가입 제한 기간(일). 제한이 꺼져 있을 때 가입했으면 null.
ALTER TABLE "BuyerMember" ADD COLUMN "rejoinRestrictionDaysAgreed" INTEGER;
-- 「재가입 제한 정보 보관 동의」 시각·문서 버전(재가입 제한을 켠 쇼핑몰에서 가입할 때만)
ALTER TABLE "BuyerMember" ADD COLUMN "rejoinRetentionAgreedAt" TIMESTAMPTZ(3);
ALTER TABLE "BuyerMember" ADD COLUMN "rejoinRetentionVersion" TEXT;
