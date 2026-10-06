-- CreateTable
CREATE TABLE "PlatformBusinessInfo" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL DEFAULT '',
    "representative" TEXT NOT NULL DEFAULT '',
    "businessNumber" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByAdminId" UUID,

    CONSTRAINT "PlatformBusinessInfo_pkey" PRIMARY KEY ("id")
);

-- 한 줄만 둔다
ALTER TABLE "PlatformBusinessInfo" ADD CONSTRAINT "PlatformBusinessInfo_single_row" CHECK ("id" = 1);
