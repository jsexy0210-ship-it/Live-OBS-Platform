-- 외부 유료 API 월 비용 원장과 월 한도 정지(자동 연결 판단 모델 호출 등)
-- CreateTable
CREATE TABLE "ExternalApiUsage" (
    "provider" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "usedWon" INTEGER NOT NULL DEFAULT 0,
    "limitWon" INTEGER NOT NULL,
    "stoppedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApiUsage_pkey" PRIMARY KEY ("provider","period"),
    CONSTRAINT "ExternalApiUsage_nonneg" CHECK ("usedWon" >= 0 AND "limitWon" > 0),
    CONSTRAINT "ExternalApiUsage_period_fmt" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$')
);

-- CreateTable
CREATE TABLE "ExternalApiCostLedger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "jobId" UUID,
    "costWon" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApiCostLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalApiCostLedger_cost_nonneg" CHECK ("costWon" >= 0)
);

-- CreateIndex
CREATE INDEX "ExternalApiCostLedger_provider_period_createdAt_idx" ON "ExternalApiCostLedger"("provider", "period", "createdAt");
