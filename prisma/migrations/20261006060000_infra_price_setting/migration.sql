-- 인프라 단가 표(MA-120, 한 행)
-- CreateTable
CREATE TABLE "InfraPriceSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "prices" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedByAdminId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfraPriceSetting_pkey" PRIMARY KEY ("id")
);
