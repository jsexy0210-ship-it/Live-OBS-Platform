-- SA-018 기존 상품 수정(상품명 일치 시 판매가·재고): 되돌리기용 변경 기록
ALTER TABLE "BulkJob" ADD COLUMN "updatedProducts" JSONB NOT NULL DEFAULT '[]';
