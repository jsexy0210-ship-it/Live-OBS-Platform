-- 쇼핑몰 홈 배너·이벤트 팝업과 그 이미지(2026-10-04 대표님 지시). 이미지는 A안(DB bytea).
-- CreateEnum
CREATE TYPE "ShopPopupTarget" AS ENUM ('HOME', 'ALL');

-- CreateEnum
CREATE TYPE "ShopPopupKind" AS ENUM ('IMAGE', 'TEXT', 'BAR');

-- CreateTable
CREATE TABLE "ShopContentImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopContentImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopBanner" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "pcImageId" UUID NOT NULL,
    "mobileImageId" UUID,
    "linkUrl" TEXT,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "showOnPc" BOOLEAN NOT NULL DEFAULT true,
    "showOnMobile" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopBanner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopPopup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "kind" "ShopPopupKind" NOT NULL DEFAULT 'IMAGE',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "imageId" UUID,
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "target" "ShopPopupTarget" NOT NULL DEFAULT 'HOME',
    "showOnPc" BOOLEAN NOT NULL DEFAULT true,
    "showOnMobile" BOOLEAN NOT NULL DEFAULT true,
    "dismissDays" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopPopup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopContentImage_sellerId_createdAt_idx" ON "ShopContentImage"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopContentImage_sellerId_id_key" ON "ShopContentImage"("sellerId", "id");

-- CreateIndex
CREATE INDEX "ShopBanner_sellerId_sortOrder_idx" ON "ShopBanner"("sellerId", "sortOrder");

-- CreateIndex
CREATE INDEX "ShopPopup_sellerId_sortOrder_idx" ON "ShopPopup"("sellerId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ShopContentImage" ADD CONSTRAINT "ShopContentImage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopBanner" ADD CONSTRAINT "ShopBanner_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopBanner" ADD CONSTRAINT "ShopBanner_sellerId_pcImageId_fkey" FOREIGN KEY ("sellerId", "pcImageId") REFERENCES "ShopContentImage"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopBanner" ADD CONSTRAINT "ShopBanner_sellerId_mobileImageId_fkey" FOREIGN KEY ("sellerId", "mobileImageId") REFERENCES "ShopContentImage"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_sellerId_imageId_fkey" FOREIGN KEY ("sellerId", "imageId") REFERENCES "ShopContentImage"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 이미지: 바이트로 확인한 PNG만(2026-10-04 MASTER 결정), 2MB까지, 한 변 100~2000px(lib/server/shop-content/image.ts와 같은 값)
ALTER TABLE "ShopContentImage" ADD CONSTRAINT "ShopContentImage_type_check" CHECK ("contentType" = 'image/png');
ALTER TABLE "ShopContentImage" ADD CONSTRAINT "ShopContentImage_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 2097152 AND octet_length("data") = "byteSize");
ALTER TABLE "ShopContentImage" ADD CONSTRAINT "ShopContentImage_dimension_check" CHECK ("width" BETWEEN 100 AND 2000 AND "height" BETWEEN 100 AND 2000);
ALTER TABLE "ShopContentImage" ADD CONSTRAINT "ShopContentImage_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- 기간: 둘 다 있으면 시작 < 종료
ALTER TABLE "ShopBanner" ADD CONSTRAINT "ShopBanner_period_check" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt");
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_period_check" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt");
-- 배너·팝업은 PC·모바일 중 하나 이상에 보인다
ALTER TABLE "ShopBanner" ADD CONSTRAINT "ShopBanner_device_check" CHECK ("showOnPc" OR "showOnMobile");
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_device_check" CHECK ("showOnPc" OR "showOnMobile");
-- 팝업 형태별 필수 값: 이미지 팝업은 이미지, 글 팝업은 내용. 「보지 않기」는 0(닫기만)·1(오늘 하루)·7(7일)
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_kind_check" CHECK (("kind" <> 'IMAGE' OR "imageId" IS NOT NULL) AND ("kind" <> 'TEXT' OR "body" IS NOT NULL));
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_dismiss_check" CHECK ("dismissDays" IN (0, 1, 7));
-- 링크: 쇼핑몰 안 경로(/로 시작, //·/\ 제외) 또는 http(s) 주소만. javascript: 등은 서버 검사(link.ts)와 함께 DB에서도 막는다.
ALTER TABLE "ShopBanner" ADD CONSTRAINT "ShopBanner_link_check" CHECK ("linkUrl" IS NULL OR "linkUrl" ~ '^(/($|[^/\\])|https?://)');
ALTER TABLE "ShopPopup" ADD CONSTRAINT "ShopPopup_link_check" CHECK ("linkUrl" IS NULL OR "linkUrl" ~ '^(/($|[^/\\])|https?://)');
