ALTER TABLE "BroadcastSession" ADD COLUMN "hostName" TEXT;

CREATE TYPE "BroadcastEventKind" AS ENUM ('CONNECTED', 'LIVE_STARTED', 'DISCONNECTED', 'RECOVERED', 'ENDED');

CREATE TABLE "BroadcastEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "broadcastSessionId" UUID,
    "kind" "BroadcastEventKind" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "downSeconds" INTEGER,
    "waiting" INTEGER,
    CONSTRAINT "BroadcastEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BroadcastEvent_broadcastSessionId_at_idx" ON "BroadcastEvent"("broadcastSessionId", "at");
CREATE INDEX "BroadcastEvent_sellerId_at_idx" ON "BroadcastEvent"("sellerId", "at");

ALTER TABLE "BroadcastEvent" ADD CONSTRAINT "BroadcastEvent_sellerId_broadcastSessionId_fkey" FOREIGN KEY ("sellerId", "broadcastSessionId") REFERENCES "BroadcastSession"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
