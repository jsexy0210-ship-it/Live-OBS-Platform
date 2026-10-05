-- CreateEnum
CREATE TYPE "PlatformNoticeCategory" AS ENUM ('MAINTENANCE', 'POLICY', 'FEATURE', 'GENERAL');

-- CreateEnum
CREATE TYPE "PlatformNoticeAudience" AS ENUM ('PARTNERS', 'PUBLIC', 'ALL');

-- CreateTable
CREATE TABLE "PlatformNotice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "PlatformNoticeCategory" NOT NULL,
    "audience" "PlatformNoticeAudience" NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" UUID NOT NULL,
    "updatedByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PlatformNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformNotice_publishedAt_id_idx" ON "PlatformNotice"("publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "PlatformNotice_createdAt_id_idx" ON "PlatformNotice"("createdAt" DESC, "id" DESC);

