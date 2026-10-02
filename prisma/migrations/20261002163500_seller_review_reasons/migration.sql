-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "rejectedAt" TIMESTAMPTZ(3),
ADD COLUMN     "rejectedReason" TEXT,
ADD COLUMN     "reviewReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
