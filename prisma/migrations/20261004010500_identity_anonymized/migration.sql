-- 본인확인 기록 비식별(행 삭제 대신): 식별 항목을 비운 시각. 한도 계산(쇼핑몰·상태·요청 시각·요청 IP)은 남긴다.
ALTER TABLE "IdentityVerification" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(3);

-- 확인을 마친(VERIFIED) 기록은 비식별 전까지 CI 해시와 완료 시각이 있어야 한다
ALTER TABLE "IdentityVerification" DROP CONSTRAINT "IdentityVerification_verified_check";
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_verified_check"
  CHECK ("status" <> 'VERIFIED' OR "anonymizedAt" IS NOT NULL OR ("ciHash" IS NOT NULL AND "verifiedAt" IS NOT NULL));
