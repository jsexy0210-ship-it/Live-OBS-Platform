-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('IMMEDIATE', 'STORAGE');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('READY', 'IN_TRANSIT', 'DELIVERED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfillmentType" "FulfillmentType" NOT NULL DEFAULT 'IMMEDIATE',
ADD COLUMN     "shippingFee" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SellerShippingPolicy" (
    "sellerId" UUID NOT NULL,
    "baseFee" INTEGER NOT NULL DEFAULT 3000,
    "freeOverAmount" INTEGER,
    "remoteSurcharge" INTEGER NOT NULL DEFAULT 3000,
    "remoteZipRanges" JSONB NOT NULL DEFAULT '[[63000, 63644], [40200, 40240]]',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerShippingPolicy_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "OrderShippingAddress" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "recipientName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "zipCode" TEXT NOT NULL,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "memo" TEXT,
    "isRemote" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OrderShippingAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "courier" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "shippedAt" TIMESTAMPTZ(3) NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderShippingAddress_orderId_key" ON "OrderShippingAddress"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderShippingAddress_sellerId_orderId_key" ON "OrderShippingAddress"("sellerId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_orderId_key" ON "Shipment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_sellerId_orderId_key" ON "Shipment"("sellerId", "orderId");

-- AddForeignKey
ALTER TABLE "SellerShippingPolicy" ADD CONSTRAINT "SellerShippingPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderShippingAddress" ADD CONSTRAINT "OrderShippingAddress_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderShippingAddress" ADD CONSTRAINT "OrderShippingAddress_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
