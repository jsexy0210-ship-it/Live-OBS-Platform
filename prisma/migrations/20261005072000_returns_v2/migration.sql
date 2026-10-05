-- 교환·반품 v2: 수거 방법, 검수 결과, 교환 재고 없음 처리(보류·환불 전환), 무통장 환불 계좌
-- CreateEnum
CREATE TYPE "ReturnPickup" AS ENUM ('COURIER', 'BUYER_SHIP', 'NONE');

-- CreateEnum
CREATE TYPE "ReturnInspection" AS ENUM ('OK', 'USED_DAMAGED', 'MISSING_PARTS');

-- AlterTable
ALTER TABLE "ReturnRequest" ADD COLUMN     "convertedFromExchange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exchangeHeldAt" TIMESTAMPTZ(3),
ADD COLUMN     "inspectedAt" TIMESTAMPTZ(3),
ADD COLUMN     "inspectionNote" TEXT,
ADD COLUMN     "inspectionResult" "ReturnInspection",
ADD COLUMN     "pickupMethod" "ReturnPickup" NOT NULL DEFAULT 'BUYER_SHIP',
ADD COLUMN     "refundAccountHolder" TEXT,
ADD COLUMN     "refundAccountNumber" TEXT,
ADD COLUMN     "refundBankName" TEXT;

-- 검수에서 문제가 확인돼 반송·거절한 신청은 접수·회수 완료 기록을 남긴 채 거절로 닫힌다(REJECTED 조건에서 acceptedAt·receivedAt 제한을 푼다)
ALTER TABLE "ReturnRequest" DROP CONSTRAINT "ReturnRequest_status_fields";
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_status_fields" CHECK (
  ("status" = 'REQUESTED' AND "acceptedAt" IS NULL AND "receivedAt" IS NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "fault" IS NOT NULL AND "receivedAt" IS NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'RECEIVED' AND "acceptedAt" IS NOT NULL AND "fault" IS NOT NULL AND "receivedAt" IS NOT NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'COMPLETED' AND "acceptedAt" IS NOT NULL AND "fault" IS NOT NULL AND "receivedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "rejectedAt" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'REJECTED' AND "rejectedAt" IS NOT NULL AND "rejectReason" IS NOT NULL AND "completedAt" IS NULL AND "cancelledAt" IS NULL AND ("acceptedAt" IS NULL) = ("receivedAt" IS NULL AND "inspectedAt" IS NULL))
  OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL AND "rejectedAt" IS NULL)
);
