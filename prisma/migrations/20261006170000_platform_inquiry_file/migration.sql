-- CreateTable
CREATE TABLE "PlatformInquiryFile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "messageId" UUID,
    "name" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInquiryFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformInquiryFile_sellerId_messageId_idx" ON "PlatformInquiryFile"("sellerId", "messageId");

-- CreateIndex
CREATE INDEX "PlatformInquiryFile_sellerId_sellerUserId_messageId_created_idx" ON "PlatformInquiryFile"("sellerId", "sellerUserId", "messageId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformInquiryFile" ADD CONSTRAINT "PlatformInquiryFile_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInquiryFile" ADD CONSTRAINT "PlatformInquiryFile_sellerId_messageId_fkey" FOREIGN KEY ("sellerId", "messageId") REFERENCES "PlatformInquiryMessage"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

