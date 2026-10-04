-- 구매자 마케팅 수신 동의 문서 버전·철회 시각
ALTER TABLE "BuyerMember" ADD COLUMN "marketingConsentVersion" TEXT, ADD COLUMN "marketingWithdrawnAt" TIMESTAMPTZ(3);
-- 이미 동의한 회원은 가입 때 동의 기록(signupConsent.marketing.version)에서 버전을 옮긴다
UPDATE "BuyerMember" SET "marketingConsentVersion" = "signupConsent"->'marketing'->>'version'
WHERE "marketingConsentAt" IS NOT NULL AND "signupConsent"->'marketing'->>'version' IS NOT NULL;
