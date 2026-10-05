-- CreateEnum
CREATE TYPE "PlatformInquiryCategory" AS ENUM ('BILLING', 'ACCOUNT', 'FEATURE', 'BUG', 'OTHER');

-- CreateEnum
CREATE TYPE "PlatformInquiryStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlatformInquiryAuthor" AS ENUM ('SELLER_USER', 'ADMIN');

-- CreateTable
CREATE TABLE "PlatformInquiry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "createdBySellerUserId" UUID NOT NULL,
    "category" "PlatformInquiryCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "PlatformInquiryStatus" NOT NULL DEFAULT 'OPEN',
    "noticeId" UUID,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAdminMessageAt" TIMESTAMPTZ(3),
    "sellerReadAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closedByAdminId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformInquiryMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "inquiryId" UUID NOT NULL,
    "authorType" "PlatformInquiryAuthor" NOT NULL,
    "sellerUserId" UUID,
    "adminId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInquiryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformInquiryImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "messageId" UUID,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformInquiryImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformInquiry_sellerId_lastMessageAt_id_idx" ON "PlatformInquiry"("sellerId", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "PlatformInquiry_status_lastMessageAt_id_idx" ON "PlatformInquiry"("status", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "PlatformInquiry_lastMessageAt_id_idx" ON "PlatformInquiry"("lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInquiry_sellerId_id_key" ON "PlatformInquiry"("sellerId", "id");

-- CreateIndex
CREATE INDEX "PlatformInquiryMessage_sellerId_inquiryId_createdAt_idx" ON "PlatformInquiryMessage"("sellerId", "inquiryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformInquiryMessage_sellerId_id_key" ON "PlatformInquiryMessage"("sellerId", "id");

-- CreateIndex
CREATE INDEX "PlatformInquiryImage_sellerId_messageId_idx" ON "PlatformInquiryImage"("sellerId", "messageId");

-- CreateIndex
CREATE INDEX "PlatformInquiryImage_sellerId_sellerUserId_messageId_create_idx" ON "PlatformInquiryImage"("sellerId", "sellerUserId", "messageId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformInquiry" ADD CONSTRAINT "PlatformInquiry_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInquiryMessage" ADD CONSTRAINT "PlatformInquiryMessage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInquiryMessage" ADD CONSTRAINT "PlatformInquiryMessage_sellerId_inquiryId_fkey" FOREIGN KEY ("sellerId", "inquiryId") REFERENCES "PlatformInquiry"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInquiryImage" ADD CONSTRAINT "PlatformInquiryImage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformInquiryImage" ADD CONSTRAINT "PlatformInquiryImage_sellerId_messageId_fkey" FOREIGN KEY ("sellerId", "messageId") REFERENCES "PlatformInquiryMessage"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 쓴 사람 종류와 id가 맞아야 한다(파트너스 글은 계정 id, 마스터 답변은 관리자 id)
ALTER TABLE "PlatformInquiryMessage" ADD CONSTRAINT "PlatformInquiryMessage_author_check" CHECK (
  ("authorType" = 'SELLER_USER' AND "sellerUserId" IS NOT NULL AND "adminId" IS NULL)
  OR ("authorType" = 'ADMIN' AND "adminId" IS NOT NULL AND "sellerUserId" IS NULL)
);
