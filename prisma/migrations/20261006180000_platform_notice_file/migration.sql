-- CreateTable
CREATE TABLE "PlatformNoticeFile" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "noticeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformNoticeFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformNoticeFile_noticeId_sortOrder_createdAt_idx" ON "PlatformNoticeFile"("noticeId", "sortOrder", "createdAt");

-- AddForeignKey
ALTER TABLE "PlatformNoticeFile" ADD CONSTRAINT "PlatformNoticeFile_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PlatformNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

