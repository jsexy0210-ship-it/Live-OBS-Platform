// 회원과 이어진 표마다 탈퇴 때 어떻게 하는지(PRODUCT_SCOPE 「구매자 탈퇴·재가입」, buyers/withdraw.ts).
// - delete: 탈퇴 트랜잭션에서 행을 지운다
// - anonymize: 행은 두고 개인정보 칸만 비식별 값으로 바꾼다
// - retain_legal: 법정 보관 기록이라 그대로 두고 보관 기간이 지나면 파기한다(파기 함수는 별도)
// 회원과 이어진 표(BuyerMember 관계·buyerMemberId 칸)를 새로 만들면 여기에 넣어야 한다. 빠지면 tests/unit/memberData.test.ts가 실패한다.
export type MemberDataPolicy = "delete" | "anonymize" | "retain_legal";

export const MEMBER_DATA_POLICY: Record<string, { policy: MemberDataPolicy; note: string }> = {
  BuyerMember: { policy: "anonymize", note: "이름·휴대폰·닉네임·아이디·CI 해시·생년월일·비밀번호·마케팅 동의 비식별, WITHDRAWN·deletedAt" },
  BuyerAddress: { policy: "delete", note: "저장 배송지" },
  BuyerSession: { policy: "delete", note: "로그인 세션" },
  BuyerPurchaseRestriction: { policy: "delete", note: "구매 제한(개인정보 없음, 탈퇴하면 쓸 일 없음)" },
  IdentityVerification: { policy: "delete", note: "이 쇼핑몰에서 회원과 이어진(subjectId) 또는 같은 CI 해시의 본인확인 기록" },
  Order: { policy: "retain_legal", note: "대금 결제·재화 공급 기록 5년(받는 사람 스냅숏 포함). 방송 닉네임 스냅숏만 「탈퇴한 회원」으로" },
  QueueItem: { policy: "anonymize", note: "그 회원 주문의 주문대기 닉네임 스냅숏을 「탈퇴한 회원」으로" },
  HitCard: { policy: "anonymize", note: "닉네임 스냅숏을 「탈퇴한 회원」으로" },
  RewardLedger: { policy: "retain_legal", note: "적립금 원장(거래 기록). 처리 전 원장은 FAILED(member_withdrawn)" },
  RewardBalance: { policy: "anonymize", note: "잔액을 소멸 원장으로 0(개인정보 없음)" },
};

// 탈퇴 회원 표시 이름(닉네임 스냅숏 비식별 값)
export const WITHDRAWN_DISPLAY_NAME = "탈퇴한 회원";
