import { BUYER_PHONE_CHANGE_IDV_COOKIE } from "../../../../../../../../lib/server/buyers/phoneChange";
import { identityStepRoute } from "../../../../../../../../lib/server/identity/http";

// 구매자 휴대폰 번호 변경 본인확인: 인증번호 확인(본문 { verificationId, code }). 성공해도 번호는 아직 바뀌지 않는다(POST /me/phone이 바꾼다).
export const POST = identityStepRoute("confirm", "BUYER_PHONE_CHANGE", BUYER_PHONE_CHANGE_IDV_COOKIE);
