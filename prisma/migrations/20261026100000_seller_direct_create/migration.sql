-- 파트너스 직접 추가(마스터 최고관리자 전용): 추가형. 기존 행·로직 영향 없음.
ALTER TABLE "Seller" ADD COLUMN "directCreatedByAdminId" UUID,
ADD COLUMN "directCreatedAt" TIMESTAMPTZ(3);

CREATE TABLE "SellerInvite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SellerInvite_tokenHash_key" ON "SellerInvite"("tokenHash");
CREATE INDEX "SellerInvite_sellerUserId_createdAt_idx" ON "SellerInvite"("sellerUserId", "createdAt");

ALTER TABLE "SellerInvite" ADD CONSTRAINT "SellerInvite_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerInvite" ADD CONSTRAINT "SellerInvite_sellerUserId_fkey" FOREIGN KEY ("sellerUserId") REFERENCES "SellerUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
