-- 탈퇴 때 회원 생년월일과 그 회원의 본인확인 기록(이름·휴대폰·생년월일·CI 해시·요청 IP)을 지운다(PRODUCT_SCOPE 「구매자 탈퇴·재가입」)
ALTER TABLE "BuyerMember" ALTER COLUMN "birthDate" DROP NOT NULL;
ALTER TABLE "IdentityVerification" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(3);

-- 확인됨 기록에는 CI 해시·완료 시각이 있어야 한다. 탈퇴로 비식별한 기록(anonymizedAt)만 예외.
ALTER TABLE "IdentityVerification" DROP CONSTRAINT "IdentityVerification_verified_check";
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_verified_check"
  CHECK ("status" <> 'VERIFIED' OR "anonymizedAt" IS NOT NULL OR ("ciHash" IS NOT NULL AND "verifiedAt" IS NOT NULL));
