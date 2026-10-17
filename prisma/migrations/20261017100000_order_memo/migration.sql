-- SA-021 주문 메모(파트너스 「메모 남기기」). 주문마다 1건.
CREATE TABLE "OrderMemo" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "sellerId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderMemo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderMemo_sellerId_orderId_key" ON "OrderMemo"("sellerId", "orderId");
ALTER TABLE "OrderMemo" ADD CONSTRAINT "OrderMemo_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
