-- CreateEnum
CREATE TYPE "AdminAlertSeverity" AS ENUM ('URGENT', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "AdminAlertStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED');

-- CreateTable
CREATE TABLE "AdminAlert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "severity" "AdminAlertSeverity" NOT NULL,
    "sellerId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkPath" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "targetRoles" "PlatformAdminRole"[],
    "status" "AdminAlertStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAdminId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAlertRead" (
    "adminId" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAlertRead_pkey" PRIMARY KEY ("adminId","alertId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminAlert_dedupeKey_key" ON "AdminAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "AdminAlert_status_occurredAt_id_idx" ON "AdminAlert"("status", "occurredAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AdminAlert_occurredAt_id_idx" ON "AdminAlert"("occurredAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "AdminAlertRead" ADD CONSTRAINT "AdminAlertRead_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "AdminAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

