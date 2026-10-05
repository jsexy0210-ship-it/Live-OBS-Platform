-- CreateTable
CREATE TABLE "SellerOnboarding" (
    "sellerId" UUID NOT NULL,
    "overlayUrlCopiedAt" TIMESTAMPTZ(3),
    "dismissedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SellerOnboarding_pkey" PRIMARY KEY ("sellerId")
);
