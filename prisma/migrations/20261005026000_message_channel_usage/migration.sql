-- 발송·이용 충전금 차감 항목 추가(docs/COST_POLICY.md): 송장 발급·송장 라벨·현금영수증·전자세금계산서
ALTER TYPE "MessageChannel" ADD VALUE 'INVOICE_ISSUE';
ALTER TYPE "MessageChannel" ADD VALUE 'INVOICE_LABEL';
ALTER TYPE "MessageChannel" ADD VALUE 'CASH_RECEIPT';
ALTER TYPE "MessageChannel" ADD VALUE 'TAX_INVOICE';
