-- 기존 공지는 전체 대상을 보존한다. 특정 대상의 빈 초안은 전체 공지가 아니다.
CREATE TYPE "PlatformNoticeTargetMode" AS ENUM ('ALL', 'SPECIFIC');
ALTER TABLE "PlatformNotice" ADD COLUMN "targetMode" "PlatformNoticeTargetMode" NOT NULL DEFAULT 'ALL';

-- 공지 대상 파트너스(추가형): SPECIFIC 공지의 명시 대상
CREATE TABLE "PlatformNoticeTarget" (
    "noticeId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformNoticeTarget_pkey" PRIMARY KEY ("noticeId","sellerId")
);

CREATE INDEX "PlatformNoticeTarget_sellerId_noticeId_idx" ON "PlatformNoticeTarget"("sellerId", "noticeId");

ALTER TABLE "PlatformNoticeTarget" ADD CONSTRAINT "PlatformNoticeTarget_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PlatformNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
