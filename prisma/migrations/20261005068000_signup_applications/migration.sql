-- 가입 신청 업종·보완 요청(마스터 MA-013)
ALTER TABLE "Seller"
  ADD COLUMN "businessCategory" TEXT,
  ADD COLUMN "supplementRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "supplementMessage" TEXT,
  ADD COLUMN "supplementRemindedAt" TIMESTAMPTZ(3),
  ADD COLUMN "supplementReminderCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Seller" ADD CONSTRAINT "Seller_businessCategory_len" CHECK ("businessCategory" IS NULL OR char_length("businessCategory") BETWEEN 1 AND 40);
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_supplement_shape" CHECK (
  ("supplementRequestedAt" IS NULL AND "supplementMessage" IS NULL AND "supplementRemindedAt" IS NULL AND "supplementReminderCount" = 0)
  OR ("supplementRequestedAt" IS NOT NULL AND "supplementMessage" IS NOT NULL AND char_length("supplementMessage") BETWEEN 1 AND 200 AND "supplementReminderCount" >= 0)
);
-- 승인 대기 목록(상태·접수 순)
CREATE INDEX "Seller_status_createdAt_idx" ON "Seller"("status", "createdAt");
