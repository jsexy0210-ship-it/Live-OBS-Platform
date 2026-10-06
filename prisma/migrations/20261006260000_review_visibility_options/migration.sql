-- SH-029 리뷰 공개 옵션: 닉네임 공개(기존 리뷰는 지금처럼 공개), 개봉 결과 함께 보여 주기
ALTER TABLE "ProductReview" ADD COLUMN "showNickname" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "showOpeningResult" BOOLEAN NOT NULL DEFAULT false;
