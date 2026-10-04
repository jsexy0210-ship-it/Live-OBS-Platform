-- 상품 리뷰(SA-048 리뷰 관리 · SH-029 리뷰 쓰기, 2026-10-04 대표님 지시). 값 범위는 lib/server/product-reviews/rules.ts와 같다.
-- CreateEnum
CREATE TYPE "ProductReviewStatus" AS ENUM ('VISIBLE', 'PENDING', 'HELD', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ProductReviewReason" AS ENUM ('PRIVACY', 'OFF_TOPIC', 'ABUSE', 'AD', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductReviewPublishMode" AS ENUM ('IMMEDIATE', 'REVIEW');

-- CreateTable
CREATE TABLE "ProductReviewPolicy" (
    "sellerId" UUID NOT NULL,
    "publishMode" "ProductReviewPublishMode" NOT NULL DEFAULT 'IMMEDIATE',
    "rewardText" INTEGER NOT NULL DEFAULT 0,
    "rewardPhoto" INTEGER NOT NULL DEFAULT 0,
    "writableDays" INTEGER NOT NULL DEFAULT 30,
    "bannedWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewPolicy_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "ProductReview" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "authorNickname" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ProductReviewStatus" NOT NULL DEFAULT 'VISIBLE',
    "heldBy" TEXT,
    "hiddenReason" "ProductReviewReason",
    "hiddenNote" TEXT,
    "reply" TEXT,
    "repliedAt" TIMESTAMPTZ(3),
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "rewardRound" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductReviewImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "reviewId" UUID,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductReviewReport" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "reason" "ProductReviewReason" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_orderItemId_key" ON "ProductReview"("orderItemId");

-- CreateIndex
CREATE INDEX "ProductReview_sellerId_status_createdAt_idx" ON "ProductReview"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ProductReview_sellerId_productId_status_idx" ON "ProductReview"("sellerId", "productId", "status");

-- CreateIndex
CREATE INDEX "ProductReview_sellerId_buyerMemberId_idx" ON "ProductReview"("sellerId", "buyerMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_sellerId_id_key" ON "ProductReview"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_sellerId_orderItemId_key" ON "ProductReview"("sellerId", "orderItemId");

-- CreateIndex
CREATE INDEX "ProductReviewImage_sellerId_reviewId_idx" ON "ProductReviewImage"("sellerId", "reviewId");

-- CreateIndex
CREATE INDEX "ProductReviewImage_sellerId_buyerMemberId_reviewId_idx" ON "ProductReviewImage"("sellerId", "buyerMemberId", "reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewImage_sellerId_id_key" ON "ProductReviewImage"("sellerId", "id");

-- CreateIndex
CREATE INDEX "ProductReviewReport_sellerId_reviewId_idx" ON "ProductReviewReport"("sellerId", "reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewReport_reviewId_buyerMemberId_key" ON "ProductReviewReport"("reviewId", "buyerMemberId");

-- AddForeignKey
ALTER TABLE "ProductReviewPolicy" ADD CONSTRAINT "ProductReviewPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_sellerId_orderItemId_fkey" FOREIGN KEY ("sellerId", "orderItemId") REFERENCES "OrderItem"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_sellerId_reviewId_fkey" FOREIGN KEY ("sellerId", "reviewId") REFERENCES "ProductReview"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewReport" ADD CONSTRAINT "ProductReviewReport_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewReport" ADD CONSTRAINT "ProductReviewReport_sellerId_reviewId_fkey" FOREIGN KEY ("sellerId", "reviewId") REFERENCES "ProductReview"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewReport" ADD CONSTRAINT "ProductReviewReport_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 별점 1~5, 본문 10~1000자, 답글 300자, 신고 수·적립 0 이상
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_body_check" CHECK (char_length("body") BETWEEN 10 AND 1000 OR ("deletedAt" IS NOT NULL AND "body" = ''));
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_reply_check" CHECK ("reply" IS NULL OR char_length("reply") BETWEEN 1 AND 300);
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_counts_check" CHECK ("reportCount" >= 0 AND "rewardRound" >= 0);
-- 숨긴 리뷰만 숨김 사유가 있다
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_hidden_check" CHECK (("status" = 'HIDDEN') = ("hiddenReason" IS NOT NULL) AND ("hiddenNote" IS NULL OR char_length("hiddenNote") <= 200));
-- 사진: JPEG·PNG만, 1MB까지, 긴 변 1600px까지
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_type_check" CHECK ("contentType" IN ('image/jpeg', 'image/png'));
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 1048576 AND octet_length("data") = "byteSize");
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_dimension_check" CHECK ("width" BETWEEN 1 AND 1600 AND "height" BETWEEN 1 AND 1600);
-- 설정: 적립금 0~10만 원, 작성 기간 1~365일, 금지어 50개까지
ALTER TABLE "ProductReviewPolicy" ADD CONSTRAINT "ProductReviewPolicy_check" CHECK ("rewardText" BETWEEN 0 AND 100000 AND "rewardPhoto" BETWEEN 0 AND 100000 AND "writableDays" BETWEEN 1 AND 365 AND cardinality("bannedWords") <= 50);
