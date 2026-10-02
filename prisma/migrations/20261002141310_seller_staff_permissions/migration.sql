-- 판매자 직원: 고정 역할(OWNER·MANAGER·BROADCASTER) → 대표자 여부 + 권한 항목 (대표님 결정 2026-10-02)

-- CreateEnum
CREATE TYPE "SellerStaffPermission" AS ENUM ('BROADCAST_RUN', 'OVERLAY_EDIT', 'PRODUCT_MANAGE', 'ORDER_SHIPPING', 'CUSTOMER_PII_VIEW', 'MEMBER_POINTS', 'INQUIRY_REPLY', 'RECEIPT_TAX', 'SALES_VIEW', 'SHOP_SETTINGS');

-- AlterTable: 새 컬럼 추가
ALTER TABLE "SellerUser"
ADD COLUMN     "isOwner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "permissions" "SellerStaffPermission"[] DEFAULT ARRAY[]::"SellerStaffPermission"[];

-- 기존 역할 데이터 옮기기
-- OWNER → 대표자, MANAGER → 쇼핑몰 설정을 뺀 운영 권한 전부, BROADCASTER → 방송 진행·오버레이 편집
UPDATE "SellerUser" SET "isOwner" = true WHERE "role" = 'OWNER';
UPDATE "SellerUser" SET "permissions" = ARRAY[
  'BROADCAST_RUN', 'OVERLAY_EDIT', 'PRODUCT_MANAGE', 'ORDER_SHIPPING', 'CUSTOMER_PII_VIEW',
  'MEMBER_POINTS', 'INQUIRY_REPLY', 'RECEIPT_TAX', 'SALES_VIEW'
]::"SellerStaffPermission"[] WHERE "role" = 'MANAGER';
UPDATE "SellerUser" SET "permissions" = ARRAY['BROADCAST_RUN', 'OVERLAY_EDIT']::"SellerStaffPermission"[] WHERE "role" = 'BROADCASTER';

-- AlterTable: 옛 역할 컬럼 삭제
ALTER TABLE "SellerUser" DROP COLUMN "role";

-- DropEnum
DROP TYPE "SellerUserRole";
