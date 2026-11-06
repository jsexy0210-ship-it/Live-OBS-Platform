import { BUYER_PHONE_CHANGE_IDV_COOKIE } from "../../../../../../../../lib/server/buyers/phoneChange";
import { identityStepRoute } from "../../../../../../../../lib/server/identity/http";

// 구매자 휴대폰 번호 변경 본인확인: 인증번호 다시 보내기(본문 { verificationId }, 간격·횟수 제한)
export const POST = identityStepRoute("resend", "BUYER_PHONE_CHANGE", BUYER_PHONE_CHANGE_IDV_COOKIE);
