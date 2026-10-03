import { BUYER_SIGNUP_IDV_COOKIE } from "../../../../../../../lib/server/buyers/signup";
import { identityStepRoute } from "../../../../../../../lib/server/identity/http";

// 구매자 가입 휴대폰 본인확인: 인증번호 확인(본문 { verificationId, code }, 틀린 횟수 제한) → 서버 결과 조회로 확정.
// 체험 중인 쇼핑몰은 본인확인 성공 건수 한도를 넘으면 trial_limit_exceeded.
export const POST = identityStepRoute("confirm", "BUYER_SIGNUP", BUYER_SIGNUP_IDV_COOKIE);
