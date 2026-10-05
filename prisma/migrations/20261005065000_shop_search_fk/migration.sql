-- AddForeignKey
ALTER TABLE "ShopSearchSynonym" ADD CONSTRAINT "ShopSearchSynonym_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSearchTerm" ADD CONSTRAINT "ShopSearchTerm_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

