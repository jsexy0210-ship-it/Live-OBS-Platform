-- AlterTable
ALTER TABLE "SellerSession" ADD COLUMN     "credentialVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SellerUser" ADD COLUMN     "credentialVersion" INTEGER NOT NULL DEFAULT 0;
