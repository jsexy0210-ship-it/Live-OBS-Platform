-- CreateTable
CREATE TABLE "PlatformNoticeRead" (
    "sellerUserId" UUID NOT NULL,
    "noticeId" UUID NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformNoticeRead_pkey" PRIMARY KEY ("sellerUserId","noticeId")
);

-- CreateIndex
CREATE INDEX "PlatformNoticeRead_noticeId_idx" ON "PlatformNoticeRead"("noticeId");

-- AddForeignKey
ALTER TABLE "PlatformNoticeRead" ADD CONSTRAINT "PlatformNoticeRead_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PlatformNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

