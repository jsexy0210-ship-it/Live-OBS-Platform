-- 쇼핑몰 홈 배너 자동 넘김 간격(SA-064): 0=끔(기본), 5초, 8초. 기존 쇼핑몰은 모두 끔.
ALTER TABLE "Seller" ADD COLUMN "homeBannerIntervalSec" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_homeBannerIntervalSec_check" CHECK ("homeBannerIntervalSec" IN (0, 5, 8));
