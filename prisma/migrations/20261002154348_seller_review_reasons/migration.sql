-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
