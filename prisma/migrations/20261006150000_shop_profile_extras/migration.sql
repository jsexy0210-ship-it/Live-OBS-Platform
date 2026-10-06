-- SA-060 확장: 상단 공지·홈 혜택 배너·이용안내 글·대표 주소 종류, 쇼핑몰 하단 카카오톡·유튜브 채널 주소. 모두 추가형(기본값 있음).
CREATE TYPE "PrimaryAddressKind" AS ENUM ('DEFAULT', 'CUSTOM');
ALTER TABLE "Seller" ADD COLUMN "shopTopNotice" TEXT;
ALTER TABLE "Seller" ADD COLUMN "homeBenefitBannerVisible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Seller" ADD COLUMN "shopUsageGuide" TEXT;
ALTER TABLE "Seller" ADD COLUMN "primaryAddressKind" "PrimaryAddressKind" NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE "ShopLegalNotice" ADD COLUMN "kakaoChannelUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopLegalNotice" ADD COLUMN "youtubeChannelUrl" TEXT NOT NULL DEFAULT '';
