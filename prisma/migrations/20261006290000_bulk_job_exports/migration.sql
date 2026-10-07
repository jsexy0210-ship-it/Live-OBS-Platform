-- SA-018 내보내기 이력(상품·주문·회원): 작업 종류와 사유·조건 칸(lib/server/shop-bulk-io/)
ALTER TYPE "BulkJobKind" ADD VALUE 'PRODUCT_EXPORT';
ALTER TYPE "BulkJobKind" ADD VALUE 'ORDER_EXPORT';
ALTER TYPE "BulkJobKind" ADD VALUE 'MEMBER_EXPORT';

ALTER TABLE "BulkJob" ADD COLUMN "reason" TEXT;
ALTER TABLE "BulkJob" ADD COLUMN "meta" JSONB NOT NULL DEFAULT '{}';
