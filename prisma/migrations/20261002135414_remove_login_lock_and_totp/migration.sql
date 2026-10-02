/*
  Warnings:

  - You are about to drop the column `mfaVerifiedAt` on the `AdminSession` table. All the data in the column will be lost.
  - You are about to drop the column `failedLoginCount` on the `PlatformAdmin` table. All the data in the column will be lost.
  - You are about to drop the column `lockedUntil` on the `PlatformAdmin` table. All the data in the column will be lost.
  - You are about to drop the column `totpEnabledAt` on the `PlatformAdmin` table. All the data in the column will be lost.
  - You are about to drop the column `totpSecretEnc` on the `PlatformAdmin` table. All the data in the column will be lost.
  - You are about to drop the column `failedLoginCount` on the `SellerUser` table. All the data in the column will be lost.
  - You are about to drop the column `lockedUntil` on the `SellerUser` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AdminSession" DROP COLUMN "mfaVerifiedAt";

-- AlterTable
ALTER TABLE "BuyerMember" ADD COLUMN     "lastLoginAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "PlatformAdmin" DROP COLUMN "failedLoginCount",
DROP COLUMN "lockedUntil",
DROP COLUMN "totpEnabledAt",
DROP COLUMN "totpSecretEnc";

-- AlterTable
ALTER TABLE "SellerUser" DROP COLUMN "failedLoginCount",
DROP COLUMN "lockedUntil";
