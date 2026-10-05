-- CreateEnum
CREATE TYPE "BuyerInquiryKind" AS ENUM ('PRODUCT', 'GENERAL');

-- CreateEnum
CREATE TYPE "BuyerInquiryStatus" AS ENUM ('WAITING', 'ANSWERED');

-- CreateTable
CREATE TABLE "BuyerInquiry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "kind" "BuyerInquiryKind" NOT NULL,
    "productId" UUID,
    "authorNickname" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "status" "BuyerInquiryStatus" NOT NULL DEFAULT 'WAITING',
    "answer" TEXT,
    "answeredAt" TIMESTAMPTZ(3),
    "answeredBySellerUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerInquiryImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "inquiryId" UUID,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerInquiryImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuyerInquiry_sellerId_status_createdAt_id_idx" ON "BuyerInquiry"("sellerId", "status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "BuyerInquiry_sellerId_buyerMemberId_createdAt_id_idx" ON "BuyerInquiry"("sellerId", "buyerMemberId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerInquiry_sellerId_id_key" ON "BuyerInquiry"("sellerId", "id");

-- CreateIndex
CREATE INDEX "BuyerInquiryImage_sellerId_inquiryId_idx" ON "BuyerInquiryImage"("sellerId", "inquiryId");

-- CreateIndex
CREATE INDEX "BuyerInquiryImage_sellerId_buyerMemberId_inquiryId_createdA_idx" ON "BuyerInquiryImage"("sellerId", "buyerMemberId", "inquiryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerInquiryImage_sellerId_id_key" ON "BuyerInquiryImage"("sellerId", "id");

-- AddForeignKey
ALTER TABLE "BuyerInquiry" ADD CONSTRAINT "BuyerInquiry_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerInquiry" ADD CONSTRAINT "BuyerInquiry_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerInquiry" ADD CONSTRAINT "BuyerInquiry_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerInquiryImage" ADD CONSTRAINT "BuyerInquiryImage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerInquiryImage" ADD CONSTRAINT "BuyerInquiryImage_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerInquiryImage" ADD CONSTRAINT "BuyerInquiryImage_sellerId_inquiryId_fkey" FOREIGN KEY ("sellerId", "inquiryId") REFERENCES "BuyerInquiry"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 상품 문의는 상품이 있고 1:1 문의는 상품이 없다. 답변이 있으면 ANSWERED, 없으면 WAITING.
ALTER TABLE "BuyerInquiry" ADD CONSTRAINT "BuyerInquiry_kind_product_check" CHECK (("kind" = 'PRODUCT') = ("productId" IS NOT NULL));
ALTER TABLE "BuyerInquiry" ADD CONSTRAINT "BuyerInquiry_answer_status_check" CHECK (("status" = 'ANSWERED') = ("answer" IS NOT NULL AND "answeredAt" IS NOT NULL));
