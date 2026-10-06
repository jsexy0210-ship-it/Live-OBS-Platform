-- AlterTable
ALTER TABLE "PlatformInquiry" ADD COLUMN     "closedBySellerUserId" UUID,
ADD COLUMN     "helpful" BOOLEAN,
ADD COLUMN     "helpfulAt" TIMESTAMPTZ(3),
ADD COLUMN     "relatedBroadcastId" UUID,
ADD COLUMN     "relatedOrderId" UUID;
