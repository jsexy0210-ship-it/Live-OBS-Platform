-- 구매자 주문 상세의 「결제 수단」 표시용 카드 요약(카드사 이름·끝 4자리·할부 개월). 카드번호 전체는 저장하지 않는다(PG가 앞 6·끝 4만 주고, 우리는 끝 4자리만 남김).
ALTER TABLE "Payment" ADD COLUMN "cardName" TEXT;
ALTER TABLE "Payment" ADD COLUMN "cardLast4" VARCHAR(4);
ALTER TABLE "Payment" ADD COLUMN "cardInstallment" INTEGER;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cardLast4_check" CHECK ("cardLast4" IS NULL OR "cardLast4" ~ '^[0-9]{4}$');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_cardInstallment_check" CHECK ("cardInstallment" IS NULL OR ("cardInstallment" >= 0 AND "cardInstallment" <= 60));
