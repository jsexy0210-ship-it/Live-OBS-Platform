-- CreateTable
CREATE TABLE "OverlayLayout" (
    "sellerId" UUID NOT NULL,
    "aspect" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "widgets" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OverlayLayout_pkey" PRIMARY KEY ("sellerId","aspect")
);

-- CreateTable
CREATE TABLE "OverlayTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "aspect" TEXT NOT NULL,
    "widgets" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverlayTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OverlayTemplate_sellerId_createdAt_idx" ON "OverlayTemplate"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "OverlayLayout" ADD CONSTRAINT "OverlayLayout_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverlayTemplate" ADD CONSTRAINT "OverlayTemplate_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 화면 비율은 두 가지만
ALTER TABLE "OverlayLayout" ADD CONSTRAINT "OverlayLayout_aspect_check" CHECK ("aspect" IN ('9x16', '16x9'));
ALTER TABLE "OverlayTemplate" ADD CONSTRAINT "OverlayTemplate_aspect_check" CHECK ("aspect" IN ('9x16', '16x9'));
ALTER TABLE "OverlayLayout" ADD CONSTRAINT "OverlayLayout_version_positive" CHECK ("version" >= 1);
