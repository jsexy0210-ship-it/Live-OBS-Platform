// 회원과 이어진 표마다 탈퇴 때 어떻게 하는지(PRODUCT_SCOPE 「구매자 탈퇴·재가입」, buyers/withdraw.ts).
// - delete: 탈퇴 트랜잭션에서 행을 지운다
// - anonymize: 행은 두고 개인정보 칸만 비식별 값으로 바꾼다
// - retain_legal: 법정 보관 기록이라 그대로 두고 보관 기간이 지나면 파기한다(파기 함수는 별도)
// 회원과 이어진 표(BuyerMember 관계·buyerMemberId 칸)를 새로 만들면 여기에 넣어야 한다. 빠지면 tests/unit/memberData.test.ts가 실패한다.
export type MemberDataPolicy = "delete" | "anonymize" | "retain_legal";

export const MEMBER_DATA_POLICY: Record<string, { policy: MemberDataPolicy; note: string }> = {
  BuyerMember: { policy: "anonymize", note: "이름·휴대폰·닉네임·아이디·CI 해시·생년월일·비밀번호·마케팅 동의(시각·문서 버전·철회 시각)·가입 동의 기록(signupConsent)·재가입 제한 보관 동의 스냅숏 비식별, WITHDRAWN·deletedAt" },
  BuyerAddress: { policy: "delete", note: "저장 배송지" },
  CartItem: { policy: "delete", note: "장바구니(shop-cart)" },
  WishItem: { policy: "delete", note: "찜(shop-wish)" },
  RestockAlert: { policy: "delete", note: "재입고 알림 신청(shop-restock-alerts)" },
  ProductReview: { policy: "anonymize", note: "상품 리뷰는 남기고 작성자 표시를 「탈퇴 회원」으로(product-reviews anonymizeMemberReviews). 리뷰에 붙은 사진은 리뷰와 함께 남는다" },
  ProductReviewImage: { policy: "delete", note: "리뷰에 붙지 않은 사진은 지운다. 리뷰에 붙은 사진은 리뷰와 함께 남는다(리뷰는 비식별)" },
  ReturnRequest: { policy: "retain_legal", note: "교환·반품 신청(청약철회·분쟁 처리 기록, 주문과 같은 법정 보관). 신청 사유·사진은 주문과 함께 남고 보관 기간 뒤 주문 파기와 함께 지운다. 무통장 환불 계좌(은행·예금주·계좌번호)는 환불·종료 때, 탈퇴 때까지 남아 있으면 탈퇴 때 비운다" },
  RefundRequest: { policy: "retain_legal", note: "구매자 환불 요청(청약철회·분쟁 처리 기록, 주문과 같은 법정 보관). 사유는 주문과 함께 남고 보관 기간 뒤 주문 파기와 함께 지운다" },
  ReturnRequestImage: { policy: "retain_legal", note: "신청에 붙은 사진은 신청과 함께 법정 보관. 신청에 붙지 않은 사진은 탈퇴 때 지운다" },
  MemberGradeOverride: { policy: "delete", note: "파트너스가 고정한 회원 표시(개인정보 없음). 탈퇴하면 지운다" },
  MemberGradeHistory: { policy: "delete", note: "등급 변경 기록(등급 이름과 금액만, 개인정보 없음). 탈퇴하면 지운다" },
  ProductReviewReport: { policy: "anonymize", note: "리뷰 신고 기록은 남긴다(보류는 판매자만 풀어야 해서 신고 사실이 필요). 신고자는 비식별된 탈퇴 회원 행으로만 이어진다" },
  BuyerCoupon: { policy: "delete", note: "받은 쿠폰. 쓰지 않은 쿠폰은 지우고, 주문에 쓴(쓴 뒤 전체 취소로 되돌린) 쿠폰은 주문 할인 기록(CouponRedemption)과 이어져 주문과 함께 남긴다(shop-coupons)" },
  BuyerSession: { policy: "delete", note: "로그인 세션" },
  BuyerPurchaseRestriction: { policy: "delete", note: "구매 제한(개인정보 없음, 탈퇴하면 쓸 일 없음)" },
  IdentityVerification: { policy: "anonymize", note: "이 쇼핑몰에서 회원과 이어진(subjectId) 또는 같은 CI 해시의 본인확인 기록. 식별 항목·requestId만 비우고 쇼핑몰·상태·요청 시각·요청 IP는 한도 계산에 남김(요청 IP는 3개월 뒤 비움)" },
  Order: { policy: "retain_legal", note: "대금 결제·재화 공급 기록 5년(받는 사람 스냅숏·결제·환불 포함). 끝난 주문은 분리 보관 표시·만료일(buyers/legalHold.ts), 방송 닉네임 스냅숏만 「탈퇴한 회원」으로" },
  QueueItem: { policy: "anonymize", note: "그 회원 주문의 주문대기 닉네임 스냅숏을 「탈퇴한 회원」으로" },
  HitCard: { policy: "anonymize", note: "닉네임 스냅숏을 「탈퇴한 회원」으로" },
  RewardLedger: { policy: "retain_legal", note: "적립금 원장(거래 기록). 처리 전 원장은 FAILED(member_withdrawn)" },
  RewardBalance: { policy: "anonymize", note: "잔액을 소멸 원장으로 0(개인정보 없음)" },
  RewardExpiryNotice: { policy: "delete", note: "적립금 소멸 30일 전 안내 기록(잔액이 0이 되어 더 쓸 일 없음)" },
};

// 회원 전용 칸이 아니라 여러 행위자가 함께 쓰는 칸(행위자 유형이 구매자인 행에 구매자 회원 id가 들어간다).
// 「모델.칸」마다 탈퇴 때 처리. 행위자·대상 칸을 가진 표를 새로 만들면 여기에 넣어야 한다(tests/unit/memberData.test.ts).
// 법정 보관 기록의 보관 기간 뒤 비식별(행위자 id를 비식별 값으로)은 별도 파기 함수(⑩)에서 한다.
export const MEMBER_REFERENCE_POLICY: Record<string, { policy: MemberDataPolicy; note: string }> = {
  "AuditLog.actorId": { policy: "retain_legal", note: "actorType=BUYER 행. 행동 종류별(MEMBER_AUDIT_RETENTION): 기록 때 보관 기한(거래 관련 기록 시각 + 5년, 거래 무관 기록 시각 + 3개월), 탈퇴 때 거래 관련 행 분리 보관" },
  "AuditLog.targetId": { policy: "retain_legal", note: "targetType=BuyerMember 행. 위와 같음" },
  "StockMovement.actorId": { policy: "retain_legal", note: "actorType=BUYER 행(주문으로 생긴 재고 증감). 거래 기록" },
  "OrderStatusHistory.actorId": { policy: "retain_legal", note: "actorType=BUYER 행(구매자 취소 등). 거래 기록" },
  "QueueItemStatusHistory.actorId": { policy: "retain_legal", note: "actorType=BUYER 행. 주문 이행 기록" },
  "OrderRefund.actorId": { policy: "retain_legal", note: "환불한 행위자(파트너스 직원·관리자·시스템, 지금 구매자 행 없음). 환불 거래 기록" },
  "SellerMessageLedger.actorId": { policy: "retain_legal", note: "구매자 행 없음(DB CHECK로 actorType BUYER 금지, 행위자는 시스템·파트너스 직원·관리자). 발송 충전 원장" },
};

// 탈퇴 회원이 행위자·대상인 감사 로그의 행동 종류별 보관(대표님 결정 2026-10-03, PRODUCT_SCOPE 「구매자 탈퇴·재가입」).
// - transaction: 거래 관련(주문·결제·취소·환불·배송). 기록 시각 + 5년 동안 회원 id를 두고, 탈퇴하면 법정 보관으로 분리한다.
// - non_transaction: 거래 무관(로그인·로그인 실패·가입·회원 정보 수정 등). 기록 시각 + 3개월 뒤 회원 id 비식별(탈퇴와 상관없이).
// 구매자 회원 id를 행위자·대상으로 남기는 행동을 새로 만들면 여기에 넣어야 한다(tests/unit/memberData.test.ts).
export type MemberAuditRetention = "transaction" | "non_transaction";
export const MEMBER_AUDIT_RETENTION_PREFIX: Record<string, MemberAuditRetention> = {
  "order.": "transaction", // 주문 생성·결제·취소·자동 취소·환불·재고 부족·구매 확정·배송
  "buyer_return.": "transaction", // 교환·반품 신청·철회·송장(청약철회 기록 5년)
  "buyer_refund_request.": "transaction", // 환불 요청·철회(청약철회 기록 5년)
};
export const MEMBER_AUDIT_RETENTION: Record<string, MemberAuditRetention> = {
  "auth.buyer.login": "non_transaction",
  "auth.buyer.login_failed": "non_transaction",
  "buyer.signup": "non_transaction",
  "buyer.signup.verify_limited": "non_transaction", // 가입 본인확인 한도(회원 id 없이 남지만 같은 가입 분류)
  "buyer_address.create": "non_transaction",
  "buyer_address.update": "non_transaction",
  "buyer_address.delete": "non_transaction",
  "buyer.withdraw": "non_transaction",
  "buyer.withdraw_failed": "non_transaction",
  // 쿠폰 받기(내려받기·코드 입력)·틀린 코드 입력. 쿠폰 사용·되돌림은 주문 기록(order.coupon.*)이라 거래 관련.
  "buyer_coupon.download": "non_transaction",
  "buyer_coupon.code": "non_transaction",
  "buyer_coupon.code_failed": "non_transaction",
  // 상품 리뷰 쓰기·고치기·지우기·신고·사진 올리기(거래 무관)
  "buyer_review.create": "non_transaction",
  "buyer_review.update": "non_transaction",
  "buyer_review.delete": "non_transaction",
  "buyer_review.report": "non_transaction",
  "buyer_review.report_withdraw": "non_transaction",
  "buyer_review.image_upload": "non_transaction",
  "buyer_return.image_upload": "non_transaction", // 신청 전 사진 올리기(신청에 붙은 사진은 신청과 함께 보관)
  // 마케팅 수신 동의 철회·다시 동의(회원 정보 수정과 같은 분류)
  "buyer.marketing_consent.withdraw": "non_transaction",
  "buyer.marketing_consent.agree": "non_transaction",
  // 재가입 제한 정보 보관 동의 철회(회원 정보 수정과 같은 분류)
  "buyer.rejoin_retention_consent.withdraw": "non_transaction",
  // 미입금 자동 취소로 생긴 구매 제한(판매자 회원 관리). 주문 기록 자체는 order.* 행이 따로 남는다.
  "buyer.purchase_restriction.create": "non_transaction",
  "buyer.purchase_restriction.lift": "non_transaction",
};

// 행동 종류의 보관 분류. 목록에 없으면 null(탈퇴 처리는 더 긴 거래 관련 기준으로 둔다).
export function memberAuditRetention(action: string): MemberAuditRetention | null {
  if (action in MEMBER_AUDIT_RETENTION) return MEMBER_AUDIT_RETENTION[action];
  const prefix = Object.keys(MEMBER_AUDIT_RETENTION_PREFIX).find((p) => action.startsWith(p));
  return prefix ? MEMBER_AUDIT_RETENTION_PREFIX[prefix] : null;
}

// 회원이 행위자·대상인 감사 로그의 보관 개월 수(기록 시각 기준). 분류가 없으면 더 긴 거래 관련 기준.
export const TRANSACTION_AUDIT_RETENTION_MONTHS = 60;
export const NON_TRANSACTION_AUDIT_RETENTION_MONTHS = 3;
export function memberAuditRetainMonths(action: string): number {
  return memberAuditRetention(action) === "non_transaction" ? NON_TRANSACTION_AUDIT_RETENTION_MONTHS : TRANSACTION_AUDIT_RETENTION_MONTHS;
}

// 탈퇴 회원 표시 이름(닉네임 스냅숏 비식별 값)
export const WITHDRAWN_DISPLAY_NAME = "탈퇴한 회원";
