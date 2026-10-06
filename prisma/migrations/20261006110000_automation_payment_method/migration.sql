-- CreateEnum
CREATE TYPE "AutomationPaymentMethod" AS ENUM ('BILLING_KEY', 'ONE_TIME_CARD');

-- AlterTable
ALTER TABLE "AutomationPayment" ADD COLUMN "method" "AutomationPaymentMethod" NOT NULL DEFAULT 'BILLING_KEY',
ADD COLUMN "pgTid" TEXT,
ADD COLUMN "cardName" TEXT,
ADD COLUMN "cardLast4" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AutomationPayment_pgTid_key" ON "AutomationPayment"("pgTid");
