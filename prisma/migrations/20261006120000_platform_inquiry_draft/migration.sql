-- CreateTable
CREATE TABLE "PlatformInquiryDraft" (
    "sellerUserId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "category" "PlatformInquiryCategory",
    "title" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "relatedOrderId" UUID,
    "relatedBroadcastId" UUID,
    "includeDiagnostics" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInquiryDraft_pkey" PRIMARY KEY ("sellerUserId")
);

-- CreateIndex
CREATE INDEX "PlatformInquiryDraft_sellerId_idx" ON "PlatformInquiryDraft"("sellerId");

