-- 쇼핑몰 운영 상태(SA-060): 운영 중(기본)·준비 중·일시 정지. 기존 쇼핑몰은 모두 OPEN.
CREATE TYPE "ShopOperatingState" AS ENUM ('OPEN', 'PREPARING', 'PAUSED');
ALTER TABLE "Seller" ADD COLUMN "operatingState" "ShopOperatingState" NOT NULL DEFAULT 'OPEN';
