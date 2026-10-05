-- 외부 서비스 업체 등록·비교(마스터 관리자). 요금·점수는 비워 둔 채 초기 후보만 넣는다(값은 마스터 관리자가 입력).

-- CreateEnum
CREATE TYPE "ServiceVendorCategory" AS ENUM ('PG', 'SHIPPING', 'TRACKING');

-- CreateTable
CREATE TABLE "ServiceVendor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category" "ServiceVendorCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referenceFee" TEXT,
    "memo" TEXT,
    "ratings" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceVendorLogo" (
    "vendorId" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "type" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceVendorLogo_pkey" PRIMARY KEY ("vendorId")
);

-- CreateTable
CREATE TABLE "ServiceVendorSetting" (
    "category" "ServiceVendorCategory" NOT NULL,
    "weights" JSONB NOT NULL,
    "recommendedVendorId" UUID,
    "selectedVendorId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceVendorSetting_pkey" PRIMARY KEY ("category")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVendor_category_name_key" ON "ServiceVendor"("category", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceVendor_id_category_key" ON "ServiceVendor"("id", "category");

-- AddForeignKey
ALTER TABLE "ServiceVendorLogo" ADD CONSTRAINT "ServiceVendorLogo_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "ServiceVendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 추천·선택 업체는 같은 분야의 업체만(복합 외래키). 업체는 지우지 않으므로 RESTRICT.
ALTER TABLE "ServiceVendorSetting" ADD CONSTRAINT "ServiceVendorSetting_recommended_fkey" FOREIGN KEY ("recommendedVendorId", "category") REFERENCES "ServiceVendor"("id", "category") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceVendorSetting" ADD CONSTRAINT "ServiceVendorSetting_selected_fkey" FOREIGN KEY ("selectedVendorId", "category") REFERENCES "ServiceVendor"("id", "category") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 초기 가중치(docs/COST_POLICY.md). 배송조회 분야는 배송 가중치를 쓴다.
INSERT INTO "ServiceVendorSetting" ("category", "weights") VALUES
  ('PG', '{"fee":30,"setupFee":15,"recurring":15,"methods":15,"api":10,"stability":10,"settlement":5}'),
  ('SHIPPING', '{"invoiceIssue":20,"invoicePrint":15,"tracking":20,"carrierCoverage":15,"returns":10,"cost":10,"api":10}'),
  ('TRACKING', '{"invoiceIssue":20,"invoicePrint":15,"tracking":20,"carrierCoverage":15,"returns":10,"cost":10,"api":10}');

-- 초기 후보(이름·분야·메모만, 요금·점수·기능은 비움)
INSERT INTO "ServiceVendor" ("category", "name", "memo") VALUES
  ('PG', 'NICEPAY', '초기 추천(1순위)'),
  ('PG', '토스페이먼츠', '후보'),
  ('PG', 'NHN KCP', '후보'),
  ('PG', 'KG이니시스', '후보'),
  ('PG', '페이플', '후보'),
  ('SHIPPING', '굿스플로', '초기 추천(1순위, 통합 배송·송장)'),
  ('SHIPPING', '택배사 직접 연동', '대량 운영용 조건부'),
  ('TRACKING', '스마트택배', '배송조회 전용, 보조');

UPDATE "ServiceVendorSetting" s SET "recommendedVendorId" = v."id" FROM "ServiceVendor" v WHERE v."category" = s."category" AND v."name" = 'NICEPAY' AND s."category" = 'PG';
UPDATE "ServiceVendorSetting" s SET "recommendedVendorId" = v."id" FROM "ServiceVendor" v WHERE v."category" = s."category" AND v."name" = '굿스플로' AND s."category" = 'SHIPPING';
