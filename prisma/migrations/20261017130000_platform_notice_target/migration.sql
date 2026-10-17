-- 공지 대상 파트너스(추가형): 줄이 없으면 모든 파트너스, 있으면 그 파트너스에게만
CREATE TABLE "PlatformNoticeTarget" (
    "noticeId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformNoticeTarget_pkey" PRIMARY KEY ("noticeId","sellerId")
);

CREATE INDEX "PlatformNoticeTarget_sellerId_noticeId_idx" ON "PlatformNoticeTarget"("sellerId", "noticeId");

ALTER TABLE "PlatformNoticeTarget" ADD CONSTRAINT "PlatformNoticeTarget_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PlatformNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
