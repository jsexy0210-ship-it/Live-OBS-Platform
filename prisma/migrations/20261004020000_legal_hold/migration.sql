-- 탈퇴 회원 법정 보관 기록 분리 표시와 보관 만료일
ALTER TABLE "Order" ADD COLUMN "legalHoldAt" TIMESTAMPTZ(3),
ADD COLUMN "legalRetainUntil" TIMESTAMPTZ(3);

ALTER TABLE "AuditLog" ADD COLUMN "legalHoldAt" TIMESTAMPTZ(3),
ADD COLUMN "retainUntil" TIMESTAMPTZ(3);

-- 이미 끝난 주문의 보관 만료일(끝난 날 + 5년). 분리 보관 표시는 탈퇴 때만 단다.
UPDATE "Order"
SET "legalRetainUntil" = GREATEST("createdAt", "paidAt", "cancelledAt", "refundedAt", "purchaseConfirmedAt") + make_interval(years => 5)
WHERE "status" IN ('CANCELLED', 'REFUNDED') OR "purchaseConfirmedAt" IS NOT NULL;

-- 구매자 회원이 행위자·대상인 기존 감사 로그의 보관 기한(기록 시각 기준). 거래 무관 행동 목록은 이 마이그레이션 시점의
-- lib/server/buyers/memberData.ts MEMBER_AUDIT_RETENTION과 같다(3개월). 나머지는 거래 관련 기준(5년).
UPDATE "AuditLog"
SET "retainUntil" = "createdAt" + CASE
    WHEN "action" IN ('auth.buyer.login', 'auth.buyer.login_failed', 'buyer.signup', 'buyer.signup.verify_limited',
                      'buyer_address.create', 'buyer_address.update', 'buyer_address.delete', 'buyer.withdraw', 'buyer.withdraw_failed',
                      'buyer.purchase_restriction.create', 'buyer.purchase_restriction.lift')
    THEN make_interval(months => 3) ELSE make_interval(months => 60) END
WHERE ("actorType" = 'BUYER' AND "actorId" IS NOT NULL) OR "targetType" = 'BuyerMember';
