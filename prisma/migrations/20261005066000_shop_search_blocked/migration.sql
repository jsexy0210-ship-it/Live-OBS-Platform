-- CreateTable
CREATE TABLE "ShopSearchBlockedTerm" (
    "sellerId" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopSearchBlockedTerm_pkey" PRIMARY KEY ("sellerId","term")
);

-- AddForeignKey
ALTER TABLE "ShopSearchBlockedTerm" ADD CONSTRAINT "ShopSearchBlockedTerm_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 제외 단어는 1~20자
ALTER TABLE "ShopSearchBlockedTerm" ADD CONSTRAINT "ShopSearchBlockedTerm_term_check" CHECK (char_length("term") BETWEEN 1 AND 20);
