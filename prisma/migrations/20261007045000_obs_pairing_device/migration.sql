-- CreateTable
CREATE TABLE "ObsDevice" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "tokenHash" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "registeredById" UUID NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "registeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ObsDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObsPairingChallenge" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "verifierHash" TEXT NOT NULL,
    "confirmationHash" TEXT NOT NULL,
    "sellerId" UUID,
    "approvedActorId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "installJobId" UUID,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "consentVersion" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObsPairingChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ObsDevice_tokenHash_key" ON "ObsDevice"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ObsDevice_sellerId_id_key" ON "ObsDevice"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ObsPairingChallenge_verifierHash_key" ON "ObsPairingChallenge"("verifierHash");

-- CreateIndex
CREATE INDEX "ObsPairingChallenge_createdAt_idx" ON "ObsPairingChallenge"("createdAt");

-- CreateIndex
CREATE INDEX "ObsPairingChallenge_expiresAt_idx" ON "ObsPairingChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "ObsPairingChallenge_sellerId_deviceId_idx" ON "ObsPairingChallenge"("sellerId", "deviceId");

-- AddForeignKey
ALTER TABLE "ObsDevice" ADD CONSTRAINT "ObsDevice_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObsPairingChallenge" ADD CONSTRAINT "ObsPairingChallenge_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
