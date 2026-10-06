-- SA-065 이벤트 팝업: 위치·노출 페이지 5종·방송 연동 옵션·모든 팝업 잠시 끄기·노출/반응 집계
ALTER TYPE "ShopPopupTarget" ADD VALUE IF NOT EXISTS 'PRODUCT';
ALTER TYPE "ShopPopupTarget" ADD VALUE IF NOT EXISTS 'CART_ORDER';
ALTER TYPE "ShopPopupTarget" ADD VALUE IF NOT EXISTS 'SIGNUP_DONE';

CREATE TYPE "ShopPopupPosition" AS ENUM ('CENTER', 'BOTTOM_SHEET', 'BOTTOM_RIGHT');

ALTER TABLE "ShopPopup"
  ADD COLUMN "position" "ShopPopupPosition" NOT NULL DEFAULT 'CENTER',
  ADD COLUMN "endsAtBroadcastStart" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hideDuringLive" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Seller"
  ADD COLUMN "popupsPausedAt" TIMESTAMPTZ(3),
  ADD COLUMN "popupsPausedById" UUID;

CREATE TABLE "ShopPopupStat" (
  "popupId" UUID NOT NULL,
  "day" DATE NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "closes" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ShopPopupStat_pkey" PRIMARY KEY ("popupId", "day"),
  CONSTRAINT "ShopPopupStat_counts_check" CHECK ("impressions" >= 0 AND "closes" >= 0 AND "clicks" >= 0),
  CONSTRAINT "ShopPopupStat_popupId_fkey" FOREIGN KEY ("popupId") REFERENCES "ShopPopup"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
