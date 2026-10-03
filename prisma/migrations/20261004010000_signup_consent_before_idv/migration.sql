-- 가입 필수 동의를 본인확인 요청 전에 받아 본인확인 기록에 묶고, 가입하면 회원으로 옮긴다
ALTER TABLE "IdentityVerification" ADD COLUMN "signupConsent" JSONB;
ALTER TABLE "BuyerMember" ADD COLUMN "signupConsent" JSONB;
