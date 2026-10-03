-- 재고 이력(결과 재고·기록 순서 seq). seq는 옵션 행 잠금 뒤 INSERT에서 매겨져 옵션마다 실제 적용 순서와 같다.
-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "seq" BIGSERIAL NOT NULL,
ADD COLUMN     "stockAfter" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_seq_key" ON "StockMovement"("seq");

-- CreateIndex
CREATE INDEX "StockMovement_sellerId_seq_idx" ON "StockMovement"("sellerId", "seq" DESC);


-- 이동 뒤 옵션 재고를 기록한다. 재고 이동은 언제나 ProductOption.stock을 바꾼 뒤 같은 트랜잭션에서 기록하므로
-- 그 시점의 재고가 이 이동의 결과 재고다(옵션 행은 그 트랜잭션이 잠그고 있다). 코드가 값을 직접 넣으면 그 값을 쓴다.
CREATE FUNCTION "StockMovement_set_stock_after"() RETURNS trigger AS $$
BEGIN
  IF NEW."stockAfter" IS NULL THEN
    SELECT "stock" INTO NEW."stockAfter" FROM "ProductOption" WHERE "id" = NEW."optionId" AND "sellerId" = NEW."sellerId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StockMovement_set_stock_after"
  BEFORE INSERT ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION "StockMovement_set_stock_after"();
