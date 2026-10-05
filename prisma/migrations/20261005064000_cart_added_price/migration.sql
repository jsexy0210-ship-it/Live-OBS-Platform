-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "addedUnitPrice" INTEGER;

-- 담을 때 단가는 1원 이상(없으면 null)
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_addedUnitPrice_check" CHECK ("addedUnitPrice" IS NULL OR "addedUnitPrice" >= 1);
