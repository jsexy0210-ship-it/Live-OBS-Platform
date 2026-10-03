-- 앱 감시 훅(ONQ 단계 6 서버 몫, PR #159 요청): 정기 실행 heartbeat와 인프라 감시 사건
-- CreateTable
CREATE TABLE "OpsInstance" (
    "name" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "retiredAt" TIMESTAMPTZ(3),
    "registeredAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsInstance_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "OpsHeartbeat" (
    "instance" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "lastRunAt" TIMESTAMPTZ(3) NOT NULL,
    "lastStatus" TEXT NOT NULL,
    "lastError" TEXT,
    "lastOkAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OpsHeartbeat_pkey" PRIMARY KEY ("instance","generation","job")
);

-- CreateTable
CREATE TABLE "OpsEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsEvent_occurredAt_idx" ON "OpsEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "OpsEvent_key_occurredAt_idx" ON "OpsEvent"("key", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsEvent_source_eventId_key" ON "OpsEvent"("source", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "OpsEvent_seq_key" ON "OpsEvent"("seq");

