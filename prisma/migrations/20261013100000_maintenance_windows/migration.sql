-- 점검 예약·이력(MA-083)
CREATE TYPE "MaintenanceWindowStatus" AS ENUM ('SCHEDULED', 'ENDED', 'CANCELED');

CREATE TABLE "PlatformMaintenanceWindow" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "immediate" BOOLEAN NOT NULL DEFAULT false,
    "status" "MaintenanceWindowStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdByAdminId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "endedByAdminId" UUID,
    "affectedBroadcasts" INTEGER,

    CONSTRAINT "PlatformMaintenanceWindow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformMaintenanceWindow_ends_check" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt"),
    CONSTRAINT "PlatformMaintenanceWindow_closed_check" CHECK (("status" = 'SCHEDULED') = ("endedAt" IS NULL))
);

CREATE INDEX "PlatformMaintenanceWindow_status_startsAt_idx" ON "PlatformMaintenanceWindow"("status", "startsAt");
CREATE INDEX "PlatformMaintenanceWindow_endedAt_id_idx" ON "PlatformMaintenanceWindow"("endedAt" DESC, "id" DESC);

-- 지금 켜져 있는 점검(이전 방식으로 켠 것)을 창으로 옮겨 이력에 남긴다
INSERT INTO "PlatformMaintenanceWindow" ("message", "reason", "startsAt", "endsAt", "immediate", "status", "createdByAdminId")
SELECT "message", '이전 설정에서 가져옴', COALESCE("startsAt", "updatedAt"), "endsAt", ("startsAt" IS NULL), 'SCHEDULED', "updatedByAdminId"
FROM "PlatformMaintenance" WHERE "id" = 1 AND "enabled" = true AND ("endsAt" IS NULL OR "endsAt" > COALESCE("startsAt", "updatedAt"));
