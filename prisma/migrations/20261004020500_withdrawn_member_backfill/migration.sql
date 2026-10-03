-- 이 기능을 배포하기 전에 이미 탈퇴한 회원에게도 지금 탈퇴 처리와 같은 정리를 적용한다(buyers/withdraw.ts, Codex 지적).
-- 탈퇴 회원은 다시 탈퇴할 수 없어 새 탈퇴 경로가 돌지 않기 때문이다. 이미 정리된 행은 조건에 걸리지 않아 다시 실행해도 같다.

-- 1) 회원 행: 생년월일·가입 동의 기록·재가입 제한 보관 동의 스냅숏·마케팅 동의를 비운다.
UPDATE "BuyerMember"
SET "birthDate" = NULL, "signupConsent" = NULL, "rejoinRestrictionDaysAgreed" = NULL, "rejoinRetentionAgreedAt" = NULL,
    "rejoinRetentionVersion" = NULL, "marketingConsentAt" = NULL
WHERE "status" = 'WITHDRAWN';

-- 2) 그 회원과 이어진(subjectId) 또는 같은 CI 해시의 같은 쇼핑몰 본인확인 기록: 행은 남기고 식별 항목만 비운다(한도 계산 값은 유지).
--    예전 탈퇴 처리는 회원 행의 CI 해시를 ''로 비웠으므로, 회원과 이어진 본인확인 기록에서 예전 CI 해시를 먼저 모아(비식별 전 스냅숏)
--    같은 CI의 다른 시도(subjectId 없음)까지 함께 정리한다.
UPDATE "IdentityVerification" v
SET "name" = NULL, "phone" = NULL, "requestedPhone" = NULL, "birthDate" = NULL, "ciHash" = NULL, "subjectId" = NULL,
    "signupConsent" = NULL, "ownerTokenHash" = NULL, "requestId" = 'anonymized:' || gen_random_uuid()::text,
    "anonymizedAt" = COALESCE(w."deletedAt", now())
FROM (
  SELECT m."id" AS "memberId", m."sellerId", m."deletedAt", x."ciHash"
  FROM "BuyerMember" m
  LEFT JOIN "IdentityVerification" x ON x."subjectId" = m."id" AND x."sellerId" = m."sellerId" AND x."ciHash" IS NOT NULL
  WHERE m."status" = 'WITHDRAWN'
  UNION
  SELECT m."id", m."sellerId", m."deletedAt", m."ciHash" FROM "BuyerMember" m WHERE m."status" = 'WITHDRAWN' AND m."ciHash" <> ''
) w
WHERE v."sellerId" = w."sellerId" AND v."anonymizedAt" IS NULL
  AND (v."subjectId" = w."memberId" OR (w."ciHash" IS NOT NULL AND v."ciHash" = w."ciHash"));

-- 2-1) 방송 화면·주문 목록에 남는 닉네임 스냅숏(주문·주문대기·히트 카드)을 「탈퇴한 회원」으로(memberData.ts WITHDRAWN_DISPLAY_NAME)
UPDATE "Order" o SET "broadcastNicknameSnapshot" = '탈퇴한 회원'
FROM "BuyerMember" m WHERE m."id" = o."buyerMemberId" AND m."status" = 'WITHDRAWN' AND o."broadcastNicknameSnapshot" <> '탈퇴한 회원';
UPDATE "QueueItem" q SET "nicknameSnapshot" = '탈퇴한 회원'
FROM "Order" o JOIN "BuyerMember" m ON m."id" = o."buyerMemberId"
WHERE q."orderId" = o."id" AND q."sellerId" = o."sellerId" AND m."status" = 'WITHDRAWN' AND q."nicknameSnapshot" <> '탈퇴한 회원';
UPDATE "HitCard" h SET "nicknameSnapshot" = '탈퇴한 회원'
FROM "BuyerMember" m WHERE m."id" = h."buyerMemberId" AND m."status" = 'WITHDRAWN' AND h."nicknameSnapshot" <> '탈퇴한 회원';

-- 2-2) 로그인 세션·구매 제한·저장 배송지는 지운다(MEMBER_DATA_POLICY delete)
DELETE FROM "BuyerSession" s USING "BuyerMember" m WHERE m."id" = s."buyerMemberId" AND m."status" = 'WITHDRAWN';
DELETE FROM "BuyerPurchaseRestriction" r USING "BuyerMember" m WHERE m."id" = r."buyerMemberId" AND m."status" = 'WITHDRAWN';
DELETE FROM "BuyerAddress" a USING "BuyerMember" m WHERE m."id" = a."buyerMemberId" AND m."status" = 'WITHDRAWN';

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
