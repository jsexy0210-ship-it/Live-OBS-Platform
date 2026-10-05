-- 서버 자원 스냅숏(인프라 용량 실시간 확인, 최고관리자 전용 조회)
-- CreateTable
CREATE TABLE "InfraSnapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "takenAt" TIMESTAMPTZ(3) NOT NULL,
    "instance" TEXT NOT NULL,
    "diskTotalBytes" BIGINT,
    "diskUsedBytes" BIGINT,
    "memTotalBytes" BIGINT,
    "memUsedBytes" BIGINT,
    "cpuCount" INTEGER,
    "load1" DOUBLE PRECISION,
    "dbSizeBytes" BIGINT,
    "dbConnections" INTEGER,
    "dbMaxConnections" INTEGER,
    "backupLastAt" TIMESTAMPTZ(3),
    "backupCount" INTEGER,
    "backupBytes" BIGINT,

    CONSTRAINT "InfraSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InfraSnapshot_takenAt_idx" ON "InfraSnapshot"("takenAt");
