-- 비밀번호 재설정 저장 성공 시각(같은 권한·같은 새 비밀번호 재시도 멱등)
ALTER TABLE "PasswordResetGrant" ADD COLUMN "completedAt" TIMESTAMPTZ(3);
