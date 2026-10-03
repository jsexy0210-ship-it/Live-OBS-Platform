import { RECOVERY_IDV_COOKIE } from "../../../../../lib/server/auth/recoveryFlow";
import { identityStepRoute } from "../../../../../lib/server/identity/http";

// 파트너스 아이디 찾기 휴대폰 본인확인: 인증번호 다시 보내기(간격·횟수 제한)
export const POST = identityStepRoute("resend", "ACCOUNT_RECOVERY", RECOVERY_IDV_COOKIE);
