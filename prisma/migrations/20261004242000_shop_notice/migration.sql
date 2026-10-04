-- 쇼핑몰 공지·자주 묻는 질문(SA-066·SH-030)

CREATE TYPE "ShopNoticeKind" AS ENUM ('NOTICE', 'FAQ');


CREATE TABLE "ShopNotice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "kind" "ShopNoticeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopNotice_sellerId_kind_createdAt_idx" ON "ShopNotice"("sellerId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "ShopNotice" ADD CONSTRAINT "ShopNotice_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 홈 띠 고정 공지는 쇼핑몰당 1개. 고정은 공지에만, 분류는 질문에만.
CREATE UNIQUE INDEX "ShopNotice_one_pinned_per_seller" ON "ShopNotice"("sellerId") WHERE "isPinned";
ALTER TABLE "ShopNotice" ADD CONSTRAINT "ShopNotice_pinned_notice_check" CHECK (NOT "isPinned" OR ("kind" = 'NOTICE' AND "isPublished"));
ALTER TABLE "ShopNotice" ADD CONSTRAINT "ShopNotice_category_faq_check" CHECK ("category" IS NULL OR "kind" = 'FAQ');
