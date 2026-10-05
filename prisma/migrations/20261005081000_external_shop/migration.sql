-- 외부 쇼핑몰 연동 기반(연결·OAuth state·웹훅 원본 저장)
-- CreateEnum
CREATE TYPE "ExternalShopStatus" AS ENUM ('CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECT_PENDING', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "ExternalShopConnection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "shopKey" TEXT NOT NULL,
    "status" "ExternalShopStatus" NOT NULL DEFAULT 'CONNECTED',
    "accessTokenCipher" TEXT,
    "refreshTokenCipher" TEXT,
    "accessExpiresAt" TIMESTAMPTZ(3),
    "refreshExpiresAt" TIMESTAMPTZ(3),
    "scopes" TEXT,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" TIMESTAMPTZ(3),
    "disconnectedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExternalShopConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalShopConnection_shopKey_fmt" CHECK ("shopKey" ~ '^[a-z0-9][a-z0-9-]{1,40}$')
);

-- CreateTable
CREATE TABLE "ExternalOAuthState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "shopKey" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalWebhookEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ExternalWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalShopConnection_sellerId_id_key" ON "ExternalShopConnection"("sellerId", "id");
CREATE UNIQUE INDEX "ExternalShopConnection_sellerId_shopKey_key" ON "ExternalShopConnection"("sellerId", "shopKey");
CREATE INDEX "ExternalShopConnection_shopKey_status_idx" ON "ExternalShopConnection"("shopKey", "status");
-- 같은 외부 쇼핑몰이 두 파트너스에 동시에 연결되지 않는다(해제된 연결은 제외)
CREATE UNIQUE INDEX "ExternalShopConnection_shopKey_active_key" ON "ExternalShopConnection"("shopKey") WHERE "status" <> 'DISCONNECTED';
CREATE UNIQUE INDEX "ExternalOAuthState_stateHash_key" ON "ExternalOAuthState"("stateHash");
CREATE INDEX "ExternalOAuthState_sellerId_createdAt_idx" ON "ExternalOAuthState"("sellerId", "createdAt");
CREATE UNIQUE INDEX "ExternalWebhookEvent_connectionId_eventKey_key" ON "ExternalWebhookEvent"("connectionId", "eventKey");
CREATE INDEX "ExternalWebhookEvent_sellerId_receivedAt_idx" ON "ExternalWebhookEvent"("sellerId", "receivedAt");

-- AddForeignKey
ALTER TABLE "ExternalShopConnection" ADD CONSTRAINT "ExternalShopConnection_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalWebhookEvent" ADD CONSTRAINT "ExternalWebhookEvent_sellerId_connectionId_fkey" FOREIGN KEY ("sellerId", "connectionId") REFERENCES "ExternalShopConnection"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
