import { identityStepRoute } from "../../../../../lib/server/identity/http";
import { SELLER_SIGNUP_IDV_COOKIE } from "../../../../../lib/server/sellers/signupFlow";

// 판매자 가입 대표자 휴대폰 본인확인: 인증번호 다시 보내기(간격·횟수 제한)
export const POST = identityStepRoute("resend", "SELLER_REPRESENTATIVE", SELLER_SIGNUP_IDV_COOKIE);
