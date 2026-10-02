-- AlterTable
ALTER TABLE "IdentityVerification" ADD COLUMN     "consumedAt" TIMESTAMPTZ(3),
ADD COLUMN     "ownerTokenHash" TEXT,
ADD COLUMN     "subjectId" UUID;

-- CreateTable
CREATE TABLE "PasswordResetGrant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetGrant_tokenHash_key" ON "PasswordResetGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetGrant_sellerId_sellerUserId_idx" ON "PasswordResetGrant"("sellerId", "sellerUserId");

-- AddForeignKey
ALTER TABLE "PasswordResetGrant" ADD CONSTRAINT "PasswordResetGrant_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetGrant" ADD CONSTRAINT "PasswordResetGrant_sellerId_sellerUserId_fkey" FOREIGN KEY ("sellerId", "sellerUserId") REFERENCES "SellerUser"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
