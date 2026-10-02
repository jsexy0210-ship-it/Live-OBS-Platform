-- AlterTable
ALTER TABLE "AdminSession" ADD COLUMN     "enrollmentOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PlatformAdmin" ADD COLUMN     "lastTotpCounter" INTEGER,
ADD COLUMN     "totpPendingSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "LoginThrottle" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "lockedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("key")
);
