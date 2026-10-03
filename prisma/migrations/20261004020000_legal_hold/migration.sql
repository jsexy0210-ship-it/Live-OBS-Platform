-- 탈퇴 회원 법정 보관 기록 분리 표시와 보관 만료일
ALTER TABLE "Order" ADD COLUMN "legalHoldAt" TIMESTAMPTZ(3),
ADD COLUMN "legalRetainUntil" TIMESTAMPTZ(3);

ALTER TABLE "AuditLog" ADD COLUMN "legalHoldAt" TIMESTAMPTZ(3),
ADD COLUMN "retainUntil" TIMESTAMPTZ(3);
