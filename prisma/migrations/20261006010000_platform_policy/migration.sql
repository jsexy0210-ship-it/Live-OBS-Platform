-- 플랫폼 기본 정책(MA-081): 키별 정수 값. 행이 없으면 코드 기본값(lib/server/admin/platformPolicy.ts)을 쓴다. 불리언은 0/1.
CREATE TABLE "PlatformPolicy" (
    "key" TEXT NOT NULL,
    "intValue" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByAdminId" UUID,

    CONSTRAINT "PlatformPolicy_pkey" PRIMARY KEY ("key")
);
