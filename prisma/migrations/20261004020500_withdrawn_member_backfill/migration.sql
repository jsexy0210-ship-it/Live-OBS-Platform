-- 이 기능을 배포하기 전에 이미 탈퇴한 회원에게도 지금 탈퇴 처리와 같은 정리를 적용한다(buyers/withdraw.ts, Codex 지적).
-- 탈퇴 회원은 다시 탈퇴할 수 없어 새 탈퇴 경로가 돌지 않기 때문이다. 이미 정리된 행은 조건에 걸리지 않아 다시 실행해도 같다.

-- 1) 회원 행: 생년월일·가입 동의 기록·재가입 제한 보관 동의 스냅숏·마케팅 동의를 비운다.
UPDATE "BuyerMember"
SET "birthDate" = NULL, "signupConsent" = NULL, "rejoinRestrictionDaysAgreed" = NULL, "rejoinRetentionAgreedAt" = NULL,
    "rejoinRetentionVersion" = NULL, "marketingConsentAt" = NULL
WHERE "status" = 'WITHDRAWN';

-- 2) 그 회원과 이어진(subjectId) 또는 같은 CI 해시의 같은 쇼핑몰 본인확인 기록: 행은 남기고 식별 항목만 비운다(한도 계산 값은 유지).
UPDATE "IdentityVerification" v
SET "name" = NULL, "phone" = NULL, "requestedPhone" = NULL, "birthDate" = NULL, "ciHash" = NULL, "subjectId" = NULL,
    "signupConsent" = NULL, "ownerTokenHash" = NULL, "requestId" = 'anonymized:' || gen_random_uuid()::text,
    "anonymizedAt" = COALESCE(m."deletedAt", now())
FROM "BuyerMember" m
WHERE m."status" = 'WITHDRAWN' AND v."sellerId" = m."sellerId" AND v."anonymizedAt" IS NULL
  AND (v."subjectId" = m."id" OR (m."ciHash" <> '' AND v."ciHash" = m."ciHash"));

-- 3) 끝난 주문(취소·환불·구매 확정)에 분리 보관 표시를 단다(판매자·구매자 일반 조회에서 빠짐). 보관 만료일은 legal_hold 마이그레이션에서 채웠다.
UPDATE "Order" o
SET "legalHoldAt" = COALESCE(m."deletedAt", now())
FROM "BuyerMember" m
WHERE m."id" = o."buyerMemberId" AND m."status" = 'WITHDRAWN' AND o."legalHoldAt" IS NULL
  AND (o."status" IN ('CANCELLED', 'REFUNDED') OR o."purchaseConfirmedAt" IS NOT NULL);

-- 4) 그 회원이 행위자·대상인 거래 관련 감사 로그에 분리 보관 표시(거래 무관 행동 목록은 legal_hold 마이그레이션과 같다).
UPDATE "AuditLog" a
SET "legalHoldAt" = COALESCE(m."deletedAt", now())
FROM "BuyerMember" m
WHERE m."status" = 'WITHDRAWN' AND a."sellerId" = m."sellerId" AND a."legalHoldAt" IS NULL
  AND ((a."actorType" = 'BUYER' AND a."actorId" = m."id") OR (a."targetType" = 'BuyerMember' AND a."targetId" = m."id"::text))
  AND a."action" NOT IN ('auth.buyer.login', 'auth.buyer.login_failed', 'buyer.signup', 'buyer.signup.verify_limited',
                         'buyer_address.create', 'buyer_address.update', 'buyer_address.delete', 'buyer.withdraw', 'buyer.withdraw_failed',
                         'buyer.purchase_restriction.create', 'buyer.purchase_restriction.lift');
