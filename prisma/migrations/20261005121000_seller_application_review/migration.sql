-- CreateTable
CREATE TABLE "SellerApplicationReview" (
    "sellerId" UUID NOT NULL,
    "supplementReason" TEXT,
    "supplementRequestedAt" TIMESTAMPTZ(3),
    "supplementDueAt" TIMESTAMPTZ(3),
    "supplementResolvedAt" TIMESTAMPTZ(3),
    "supplementByAdminId" UUID,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerApplicationReview_pkey" PRIMARY KEY ("sellerId")
);

-- 보완 요청 사유는 200자 이내, 재촉 횟수는 0 이상, 기한은 요청 뒤
ALTER TABLE "SellerApplicationReview" ADD CONSTRAINT "SellerApplicationReview_reason_check" CHECK ("supplementReason" IS NULL OR char_length("supplementReason") BETWEEN 1 AND 200);
ALTER TABLE "SellerApplicationReview" ADD CONSTRAINT "SellerApplicationReview_reminder_check" CHECK ("reminderCount" >= 0);
ALTER TABLE "SellerApplicationReview" ADD CONSTRAINT "SellerApplicationReview_due_check" CHECK ("supplementDueAt" IS NULL OR "supplementRequestedAt" IS NULL OR "supplementDueAt" > "supplementRequestedAt");
