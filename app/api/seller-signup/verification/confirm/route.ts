import { identityStepRoute } from "../../../../../lib/server/identity/http";
import { SELLER_SIGNUP_IDV_COOKIE } from "../../../../../lib/server/sellers/signupFlow";

// 판매자 가입 대표자 휴대폰 본인확인: 인증번호 확인(본문 { verificationId, code }, 틀린 횟수 제한) → 서버 결과 조회로 확정
export const POST = identityStepRoute("confirm", "SELLER_REPRESENTATIVE", SELLER_SIGNUP_IDV_COOKIE);
