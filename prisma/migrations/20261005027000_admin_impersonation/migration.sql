-- CreateTable
CREATE TABLE "AdminImpersonationSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adminId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminImpersonationSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminImpersonationSession_tokenHash_key" ON "AdminImpersonationSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminImpersonationSession_adminId_endedAt_idx" ON "AdminImpersonationSession"("adminId", "endedAt");

-- CreateIndex
CREATE INDEX "AdminImpersonationSession_sellerId_createdAt_idx" ON "AdminImpersonationSession"("sellerId", "createdAt");
