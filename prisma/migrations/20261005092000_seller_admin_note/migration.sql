-- CreateTable
CREATE TABLE "SellerAdminNote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerAdminNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerAdminNote_sellerId_createdAt_id_idx" ON "SellerAdminNote"("sellerId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "SellerAdminNote" ADD CONSTRAINT "SellerAdminNote_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

