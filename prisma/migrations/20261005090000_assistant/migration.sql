-- CreateEnum
CREATE TYPE "AssistantCallStatus" AS ENUM ('OK', 'NO_ANSWER', 'ERROR');

-- CreateTable
CREATE TABLE "AssistantSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT NOT NULL DEFAULT '',
    "inputWonPerMTok" INTEGER NOT NULL DEFAULT 0,
    "outputWonPerMTok" INTEGER NOT NULL DEFAULT 0,
    "monthlyBudgetWon" INTEGER NOT NULL DEFAULT 10000,
    "sellerDailyLimit" INTEGER NOT NULL DEFAULT 20,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedByAdminId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantDoc" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" UUID NOT NULL,
    "updatedByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AssistantDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMonthUsage" (
    "month" TEXT NOT NULL,
    "usedMilliWon" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AssistantMonthUsage_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "AssistantSellerDay" (
    "sellerId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AssistantSellerDay_pkey" PRIMARY KEY ("sellerId","day")
);

-- CreateTable
CREATE TABLE "AssistantLedger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "sellerUserId" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMilliWon" INTEGER NOT NULL DEFAULT 0,
    "status" "AssistantCallStatus" NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantDoc_published_deletedAt_idx" ON "AssistantDoc"("published", "deletedAt");

-- CreateIndex
CREATE INDEX "AssistantLedger_createdAt_id_idx" ON "AssistantLedger"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AssistantLedger_status_createdAt_idx" ON "AssistantLedger"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AssistantLedger_month_idx" ON "AssistantLedger"("month");
