ALTER TABLE "OverlayToken" ADD COLUMN "issuedByName" TEXT;

CREATE TABLE "OverlayAccess" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "tokenId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client" TEXT NOT NULL,
    "isObs" BOOLEAN NOT NULL,
    "layout" TEXT,
    CONSTRAINT "OverlayAccess_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OverlayAccess_sellerId_at_idx" ON "OverlayAccess"("sellerId", "at");
CREATE INDEX "OverlayAccess_tokenId_at_idx" ON "OverlayAccess"("tokenId", "at");

ALTER TABLE "OverlayAccess" ADD CONSTRAINT "OverlayAccess_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "OverlayToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
