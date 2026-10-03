-- 탈퇴 때 회원 생년월일을 지운다(PRODUCT_SCOPE 「구매자 탈퇴·재가입」). 본인확인 기록은 행을 지운다(buyers/withdraw.ts).
ALTER TABLE "BuyerMember" ALTER COLUMN "birthDate" DROP NOT NULL;
