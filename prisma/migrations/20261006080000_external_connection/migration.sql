-- 외부 연결 만료일·호출 상태(MA-120)
-- CreateTable
CREATE TABLE "ExternalConnection" (
    "key" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "lastOkAt" TIMESTAMPTZ(3),
    "lastAuthErrorAt" TIMESTAMPTZ(3),
    "lastAuthErrorCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedByAdminId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalConnection_pkey" PRIMARY KEY ("key")
);
