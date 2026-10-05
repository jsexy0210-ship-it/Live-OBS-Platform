-- CreateTable
CREATE TABLE "PlatformMaintenance" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedByAdminId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformMaintenance_pkey" PRIMARY KEY ("id")
);


-- 한 줄만
ALTER TABLE "PlatformMaintenance" ADD CONSTRAINT "PlatformMaintenance_single_row" CHECK ("id" = 1);
INSERT INTO "PlatformMaintenance" ("id") VALUES (1);
