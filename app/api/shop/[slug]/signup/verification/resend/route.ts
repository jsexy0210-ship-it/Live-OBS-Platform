import { BUYER_SIGNUP_IDV_COOKIE } from "../../../../../../../lib/server/buyers/signup";
import { identityStepRoute } from "../../../../../../../lib/server/identity/http";

// 구매자 가입 휴대폰 본인확인: 인증번호 다시 보내기(본문 { verificationId }, 간격·횟수 제한)
export const POST = identityStepRoute("resend", "BUYER_SIGNUP", BUYER_SIGNUP_IDV_COOKIE);
