-- SA-027·028 송장 발급(모의)·출력·추적(lib/server/invoices/)
CREATE TYPE "InvoiceStatus" AS ENUM ('FAILED', 'ISSUED', 'PRINTED', 'PICKED_UP', 'DELIVERED');
CREATE TYPE "InvoiceEventKind" AS ENUM ('ISSUED', 'PRINTED', 'PICKUP_REQUESTED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED');

CREATE TABLE "ShipmentInvoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "courier" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'FAILED',
    "mock" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "failureCode" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "printedAt" TIMESTAMPTZ(3),
    "printFormat" TEXT,
    "pickedUpAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentInvoice_pkey" PRIMARY KEY ("id"),
    -- 번호가 없을 때만 FAILED(발급 중·실패), 번호가 있으면 발급 이후 상태
    CONSTRAINT "ShipmentInvoice_number_status_check" CHECK (("status" = 'FAILED') = ("trackingNumber" IS NULL)),
    CONSTRAINT "ShipmentInvoice_attempts_check" CHECK ("attempts" >= 1)
);

CREATE UNIQUE INDEX "ShipmentInvoice_sellerId_id_key" ON "ShipmentInvoice"("sellerId", "id");
CREATE INDEX "ShipmentInvoice_sellerId_status_createdAt_idx" ON "ShipmentInvoice"("sellerId", "status", "createdAt");
-- 같은 택배사 송장번호는 쇼핑몰 안에서 한 번만
CREATE UNIQUE INDEX "ShipmentInvoice_number_key" ON "ShipmentInvoice"("sellerId", "courier", "trackingNumber") WHERE "trackingNumber" IS NOT NULL;

CREATE TABLE "ShipmentInvoiceOrder" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentInvoiceOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShipmentInvoiceOrder_orderId_key" ON "ShipmentInvoiceOrder"("orderId");
CREATE UNIQUE INDEX "ShipmentInvoiceOrder_sellerId_orderId_key" ON "ShipmentInvoiceOrder"("sellerId", "orderId");
CREATE INDEX "ShipmentInvoiceOrder_sellerId_invoiceId_idx" ON "ShipmentInvoiceOrder"("sellerId", "invoiceId");

CREATE TABLE "ShipmentInvoiceEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "kind" "InvoiceEventKind" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentInvoiceEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShipmentInvoiceEvent_invoiceId_kind_key" ON "ShipmentInvoiceEvent"("invoiceId", "kind");
CREATE INDEX "ShipmentInvoiceEvent_sellerId_invoiceId_at_idx" ON "ShipmentInvoiceEvent"("sellerId", "invoiceId", "at");

ALTER TABLE "ShipmentInvoice" ADD CONSTRAINT "ShipmentInvoice_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentInvoiceOrder" ADD CONSTRAINT "ShipmentInvoiceOrder_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentInvoiceOrder" ADD CONSTRAINT "ShipmentInvoiceOrder_sellerId_invoiceId_fkey" FOREIGN KEY ("sellerId", "invoiceId") REFERENCES "ShipmentInvoice"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentInvoiceOrder" ADD CONSTRAINT "ShipmentInvoiceOrder_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentInvoiceEvent" ADD CONSTRAINT "ShipmentInvoiceEvent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShipmentInvoiceEvent" ADD CONSTRAINT "ShipmentInvoiceEvent_sellerId_invoiceId_fkey" FOREIGN KEY ("sellerId", "invoiceId") REFERENCES "ShipmentInvoice"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
