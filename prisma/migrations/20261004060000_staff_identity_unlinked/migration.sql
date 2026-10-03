-- 직원 본인확인 연결이 휴대폰 번호 변경으로 풀린 시각(처음 미연결과 구별, GET /api/seller/me/identity relinkRequired)
ALTER TABLE "SellerUser" ADD COLUMN "identityUnlinkedAt" TIMESTAMPTZ(3);
