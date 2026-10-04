-- 쇼핑몰이 없는 본인확인 기록(파트너스 가입·없는 쇼핑몰 주소의 비밀번호 찾기)의 재시도 키 유니크.
-- (sellerId, attemptKeyHash) 유니크는 sellerId가 NULL이면 듣지 않아 용도별로 따로 막는다(lib/server/identity/attempt.ts).
CREATE UNIQUE INDEX "IdentityVerification_purpose_attemptKeyHash_no_seller_key" ON "IdentityVerification"("purpose", "attemptKeyHash") WHERE "sellerId" IS NULL AND "attemptKeyHash" IS NOT NULL;
