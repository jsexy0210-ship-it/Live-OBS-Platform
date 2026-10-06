-- SH-024 회원정보 수정: 방송 닉네임 마지막 변경 시각(30일에 1번 제한)
ALTER TABLE "BuyerMember" ADD COLUMN "broadcastNicknameChangedAt" TIMESTAMPTZ(3);
