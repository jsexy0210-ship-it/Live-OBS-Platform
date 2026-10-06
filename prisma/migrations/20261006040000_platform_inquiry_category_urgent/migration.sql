-- AlterEnum
ALTER TYPE "PlatformInquiryCategory" ADD VALUE 'BROADCAST';
ALTER TYPE "PlatformInquiryCategory" ADD VALUE 'PAYMENT_LINK';
ALTER TYPE "PlatformInquiryCategory" ADD VALUE 'ORDER_REFUND';
ALTER TYPE "PlatformInquiryCategory" ADD VALUE 'REWARD';
ALTER TYPE "PlatformInquiryCategory" ADD VALUE 'SUBSCRIPTION_FEE';
ALTER TYPE "PlatformInquiryCategory" ADD VALUE 'SHOP';

-- AlterTable
ALTER TABLE "PlatformInquiry" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
