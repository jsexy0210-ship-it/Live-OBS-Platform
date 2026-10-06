-- CreateEnum
CREATE TYPE "MessageShortageReason" AS ENUM ('INSUFFICIENT_BALANCE', 'CHARGING_DISABLED');

-- CreateTable
CREATE TABLE "MessageShortage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "reason" "MessageShortageReason" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAt" TIMESTAMPTZ(3) NOT NULL,
    "lastEventKey" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "MessageShortage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageShortage_sellerId_resolvedAt_lastAt_idx" ON "MessageShortage"("sellerId", "resolvedAt", "lastAt" DESC);

-- 같은 판매자·채널·사유의 열린 행은 1개(부분 유니크)
CREATE UNIQUE INDEX "MessageShortage_open_key" ON "MessageShortage"("sellerId", "channel", "reason") WHERE "resolvedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "MessageShortage" ADD CONSTRAINT "MessageShortage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
