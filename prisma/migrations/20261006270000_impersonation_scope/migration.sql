-- 마스터 대리 조회(MA-016): 접근 사유 분류·관련 건·열람 범위
CREATE TYPE "ImpersonationCategory" AS ENUM ('INQUIRY', 'INCIDENT', 'FINANCE_CHECK', 'AUDIT');
CREATE TYPE "ImpersonationRelatedKind" AS ENUM ('INQUIRY', 'NOTIFICATION', 'REPORT');
CREATE TYPE "ImpersonationScope" AS ENUM ('BROADCAST', 'OVERLAY', 'ORDERS', 'MEMBERS', 'SETTINGS_PG');

ALTER TABLE "AdminImpersonationSession"
  ADD COLUMN "category" "ImpersonationCategory",
  ADD COLUMN "relatedKind" "ImpersonationRelatedKind",
  ADD COLUMN "relatedId" UUID,
  ADD COLUMN "scopes" "ImpersonationScope"[] NOT NULL DEFAULT ARRAY[]::"ImpersonationScope"[];

-- 이미 열려 있던 세션은 그때 열려 있던 범위(주문·회원)로 채운다
UPDATE "AdminImpersonationSession" SET "scopes" = ARRAY['ORDERS', 'MEMBERS']::"ImpersonationScope"[];

-- 관련 건은 종류와 함께 있어야 한다
ALTER TABLE "AdminImpersonationSession"
  ADD CONSTRAINT "AdminImpersonationSession_related_check" CHECK (("relatedKind" IS NULL) = ("relatedId" IS NULL));
