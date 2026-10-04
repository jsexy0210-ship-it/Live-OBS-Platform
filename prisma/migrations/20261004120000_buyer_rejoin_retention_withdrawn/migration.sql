-- 재가입 제한 정보 보관 동의를 마지막으로 철회한 시각(buyers/rejoinConsent.ts). 탈퇴 때 비운다.
ALTER TABLE "BuyerMember" ADD COLUMN "rejoinRetentionWithdrawnAt" TIMESTAMPTZ(3);
